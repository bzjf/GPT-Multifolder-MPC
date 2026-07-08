import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { FileClassifier } from "./file-classifier.js";
import { IgnoreEngine, isPublicEnvTemplatePath } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";
import { SecretScanner } from "./secret-scanner.js";
import { readFileWindow } from "./bounded-read.js";

export type FetchFileOptions = {
  path: string;
  start_line?: number;
  end_line?: number;
  byte_offset?: number;
  cursor?: string;
  max_bytes?: number;
  override_default_excludes?: boolean;
};

type ReadMode = "bytes" | "lines";

type FileCursor = {
  version: 1;
  path: string;
  mode: ReadMode;
  file_size_bytes: number;
  mtime_ms: number;
  next_byte_offset?: number;
  next_line?: number;
  end_line?: number;
};

type LineWindowResult = {
  text: string;
  returned_bytes: number;
  start_line: number;
  end_line: number;
  total_lines?: number;
  truncated: boolean;
  next_line?: number;
};

type ReadWindowResult = {
  text: string;
  total_lines?: number;
  start_line?: number;
  end_line?: number;
  byte_start?: number;
  byte_end?: number;
  truncated: boolean;
  next_line?: number;
  requested_end_line?: number;
};

export class FileReader {
  private readonly ignoreEngine = new IgnoreEngine();
  private readonly classifier = new FileClassifier(this.ignoreEngine);
  private readonly scanner = new SecretScanner();

  constructor(
    private readonly sandbox: PathSandbox,
    private readonly maxBytesPerFile: number = DEFAULT_LIMITS.max_bytes_per_file,
    private readonly maxLineScanBytes: number = DEFAULT_LIMITS.max_line_scan_bytes
  ) {}

  async read(options: FetchFileOptions) {
    validateSelectors(options);
    const resolved = await this.sandbox.resolve(options.path);
    if (!resolved.stat.isFile()) {
      throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Not a regular file: ${resolved.repoPath}`);
    }

    const warnings: string[] = [];
    if (this.ignoreEngine.isIgnored(resolved.repoPath) && !options.override_default_excludes) {
      throw new RepoReaderError("DEFAULT_EXCLUDE_BLOCKED", `Path is excluded by default: ${resolved.repoPath}`);
    }
    if (this.ignoreEngine.isIgnored(resolved.repoPath) && options.override_default_excludes) {
      warnings.push(`Read default-excluded path with override: ${resolved.repoPath}`);
    }
    if (this.ignoreEngine.isSensitiveCandidate(resolved.repoPath)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Sensitive path blocked: ${resolved.repoPath}`);
    }

    const classification = await this.classifier.classify(resolved.repoPath, resolved.absolutePath, resolved.stat);
    if (classification.is_binary) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file blocked: ${resolved.repoPath}`);
    }

    if (isPublicEnvTemplatePath(resolved.repoPath)) {
      if (resolved.stat.size > this.maxLineScanBytes) {
        throw new RepoReaderError(
          "SIZE_LIMIT_EXCEEDED",
          `Public environment template exceeds the safe full-scan limit (${this.maxLineScanBytes} bytes): ${resolved.repoPath}`
        );
      }
      await this.assertPublicTemplateSafe(resolved.absolutePath, resolved.repoPath);
    }

    const responseLimit = Math.min(options.max_bytes ?? this.maxBytesPerFile, this.maxBytesPerFile);
    const initialFileSize = toSafeNumber(resolved.stat.size, "file size");
    const initialMtime = toSafeNumber(resolved.stat.mtimeMs, "file mtime");
    const cursor = options.cursor
      ? decodeAndValidateCursor(options.cursor, resolved.repoPath, initialFileSize, initialMtime)
      : undefined;
    const mode: ReadMode = cursor?.mode
      ?? (options.start_line !== undefined || options.end_line !== undefined ? "lines" : "bytes");
    const requestedByteOffset = cursor?.next_byte_offset ?? options.byte_offset ?? 0;
    if (mode === "bytes" && requestedByteOffset > initialFileSize) {
      throw new RepoReaderError("VALIDATION_ERROR", "byte_offset is beyond the end of the file.");
    }

    const raw: ReadWindowResult = mode === "lines"
      ? await this.readLines(
        resolved.absolutePath,
        cursor?.next_line ?? options.start_line ?? 1,
        cursor?.end_line ?? options.end_line,
        responseLimit
      )
      : await this.readBytes(
        resolved.absolutePath,
        requestedByteOffset,
        responseLimit,
        warnings
      );

    const afterRead = await stat(resolved.absolutePath);
    if (
      toSafeNumber(afterRead.size, "file size") !== initialFileSize
      || toSafeNumber(afterRead.mtimeMs, "file mtime") !== initialMtime
    ) {
      throw new RepoReaderError("STALE_CURSOR", `File changed while it was being read: ${resolved.repoPath}`, { retryable: true });
    }

    const text = this.scanner.redact(raw.text);
    const returnedBytes = Buffer.byteLength(text, "utf8");
    if (returnedBytes > responseLimit) {
      throw new RepoReaderError(
        "SIZE_LIMIT_EXCEEDED",
        "Redacted output exceeds the configured response-byte limit. Increase the configured limit or request a smaller line range."
      );
    }
    const chunkSha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const nextCursor = raw.truncated
      ? encodeCursor({
        version: 1,
        path: resolved.repoPath,
        mode,
        file_size_bytes: initialFileSize,
        mtime_ms: initialMtime,
        ...(mode === "bytes"
          ? { next_byte_offset: requireCursorPosition(raw.byte_end, "byte_end") }
          : {
            next_line: requireCursorPosition(raw.next_line, "next_line"),
            ...(raw.requested_end_line !== undefined ? { end_line: raw.requested_end_line } : {})
          })
      })
      : undefined;

    return {
      path: resolved.repoPath,
      language: classification.language,
      mode,
      file_size_bytes: initialFileSize,
      returned_bytes: returnedBytes,
      size_bytes: returnedBytes,
      sha256: chunkSha256,
      chunk_sha256: chunkSha256,
      ...(raw.total_lines !== undefined ? { total_lines: raw.total_lines } : {}),
      ...(raw.start_line !== undefined ? { start_line: raw.start_line } : {}),
      ...(raw.end_line !== undefined ? { end_line: raw.end_line } : {}),
      ...(raw.byte_start !== undefined ? { byte_start: raw.byte_start } : {}),
      ...(raw.byte_end !== undefined ? { byte_end: raw.byte_end } : {}),
      truncated: raw.truncated,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      text,
      warnings
    };
  }

  private async readBytes(
    absolutePath: string,
    byteOffset: number,
    maxBytes: number,
    warnings: string[]
  ): Promise<{
    text: string;
    byte_start: number;
    byte_end: number;
    total_lines?: number;
    start_line?: number;
    end_line?: number;
    truncated: boolean;
  }> {
    const window = await readFileWindow(absolutePath, byteOffset, maxBytes);
    if (window.byte_start !== window.requested_byte_start) {
      warnings.push(`Adjusted byte_offset from ${window.requested_byte_start} to UTF-8 boundary ${window.byte_start}.`);
    }
    if (window.buffer.length === 0 && window.has_more) {
      throw new RepoReaderError("PAGE_BUDGET_TOO_SMALL", "max_bytes is too small to return the next UTF-8 character.");
    }
    if (window.buffer.includes(0)) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", "Binary file content blocked.");
    }
    if (window.has_more || window.byte_start > 0) {
      await this.assertPagedByteContextSafe(
        absolutePath,
        window.byte_start,
        window.byte_end,
        window.file_size_bytes,
        maxBytes
      );
    }

    const text = decodeUtf8(window.buffer);
    const coversWholeFile = window.byte_start === 0 && !window.has_more;
    const totalLines = coversWholeFile ? countLines(text) : undefined;
    return {
      text,
      byte_start: window.byte_start,
      byte_end: window.byte_end,
      ...(totalLines !== undefined ? { total_lines: totalLines, start_line: 1, end_line: Math.max(1, totalLines) } : {}),
      truncated: window.has_more
    };
  }

  private async assertPagedByteContextSafe(
    absolutePath: string,
    byteStart: number,
    byteEnd: number,
    fileSize: number,
    pageBytes: number
  ): Promise<void> {
    const overlapBytes = Math.max(64 * 1024, pageBytes);
    const contextStart = Math.max(0, byteStart - overlapBytes);
    const contextEnd = Math.min(fileSize, byteEnd + overlapBytes);
    const context = await readFileWindow(absolutePath, contextStart, contextEnd - contextStart);
    if (context.buffer.includes(0)) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", "Binary file content blocked near the requested page.");
    }
    const relativePageStart = byteStart - context.byte_start;
    const relativePageEnd = byteEnd - context.byte_start;
    if (
      relativePageStart < 0
      || relativePageEnd < relativePageStart
      || relativePageEnd > context.buffer.length
    ) {
      throw new RepoReaderError("INTERNAL_ERROR", "Paged text context does not contain the requested byte range.");
    }
    const contextText = decodeUtf8(context.buffer);
    const textBeforePage = decodeUtf8(context.buffer.subarray(0, relativePageStart));
    const pageText = decodeUtf8(context.buffer.subarray(relativePageStart, relativePageEnd));
    const pageStart = textBeforePage.length;
    const pageEnd = pageStart + pageText.length;
    if (this.scanner.hasSensitiveMatchCrossing(contextText, pageStart, pageEnd)) {
      throw new RepoReaderError(
        "SECRET_CANDIDATE_BLOCKED",
        "Sensitive content crosses the requested byte-page boundary. Use a different byte range or remove the sensitive value before paging."
      );
    }
  }

  private async readLines(
    absolutePath: string,
    startLine: number,
    endLine: number | undefined,
    maxBytes: number
  ): Promise<LineWindowResult & { requested_end_line?: number }> {
    const stream = createReadStream(absolutePath, {
      highWaterMark: Math.min(64 * 1024, this.maxLineScanBytes)
    });
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const selected: string[] = [];
    let selectedBytes = 0;
    let pending = "";
    let lineNumber = 0;
    let lastReturnedLine: number | undefined;
    let lastByte: number | undefined;
    let stopped = false;
    let reachedEof = false;
    let truncated = false;
    let nextLine: number | undefined;
    let discardingSkippedLine = false;
    let scannedBytes = 0;

    const acceptLine = (line: string): void => {
      lineNumber += 1;
      if (lineNumber < startLine) return;
      if (endLine !== undefined && lineNumber > endLine) {
        stopped = true;
        return;
      }

      const addition = `${selected.length > 0 ? "\n" : ""}${line}`;
      const additionBytes = Buffer.byteLength(addition, "utf8");
      if (selectedBytes + additionBytes > maxBytes) {
        if (selected.length === 0) {
          throw new RepoReaderError(
            "LINE_EXCEEDS_MAX_BYTES",
            `Line ${lineNumber} exceeds max_bytes; use byte_offset or cursor pagination.`
          );
        }
        truncated = true;
        nextLine = lineNumber;
        stopped = true;
        return;
      }

      selected.push(line);
      selectedBytes += additionBytes;
      lastReturnedLine = lineNumber;
      if (endLine !== undefined && lineNumber >= endLine) stopped = true;
    };

    try {
      outer: for await (const chunk of stream) {
        const sourceBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingScanBytes = this.maxLineScanBytes - scannedBytes;
        if (remainingScanBytes <= 0) {
          throw lineScanLimitError(this.maxLineScanBytes);
        }
        const buffer = sourceBuffer.subarray(0, remainingScanBytes);
        const reachedScanLimit = buffer.length < sourceBuffer.length;
        if (buffer.length > 0) lastByte = buffer[buffer.length - 1];
        scannedBytes += buffer.length;
        if (buffer.includes(0)) {
          throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file content blocked: ${absolutePath}`);
        }
        pending += decodeUtf8Chunk(decoder, buffer);

        let newlineIndex = pending.indexOf("\n");
        while (newlineIndex !== -1) {
          let line = discardingSkippedLine ? "" : pending.slice(0, newlineIndex);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          pending = pending.slice(newlineIndex + 1);
          discardingSkippedLine = false;
          acceptLine(line);
          if (stopped) {
            break outer;
          }
          newlineIndex = pending.indexOf("\n");
        }

        if (Buffer.byteLength(pending, "utf8") > maxBytes) {
          if (lineNumber + 1 >= startLine) {
            throw new RepoReaderError(
              "LINE_EXCEEDS_MAX_BYTES",
              `Line ${lineNumber + 1} exceeds max_bytes; use byte_offset or cursor pagination.`
            );
          }
          discardingSkippedLine = true;
          pending = pending.endsWith("\r") ? "\r" : "";
        }

        if (reachedScanLimit) {
          throw lineScanLimitError(this.maxLineScanBytes);
        }
      }

      if (!stopped) {
        pending += finishUtf8Decode(decoder);
        if (pending.length > 0 || lastByte !== 0x0a) {
          acceptLine(discardingSkippedLine ? "" : pending);
        } else {
          acceptLine("");
        }
        reachedEof = true;
      }
    } finally {
      if (!stream.destroyed) stream.destroy();
    }

    const totalLines = reachedEof ? lineNumber : undefined;
    if (reachedEof && selected.length === 0 && startLine > lineNumber) {
      throw new RepoReaderError("VALIDATION_ERROR", `start_line ${startLine} is beyond the end of the file (${lineNumber} lines).`);
    }
    return {
      text: selected.join("\n"),
      returned_bytes: selectedBytes,
      start_line: startLine,
      end_line: lastReturnedLine ?? startLine,
      ...(totalLines !== undefined ? { total_lines: totalLines } : {}),
      truncated,
      ...(nextLine !== undefined ? { next_line: nextLine } : {}),
      ...(endLine !== undefined ? { requested_end_line: endLine } : {})
    };
  }

  private async assertPublicTemplateSafe(absolutePath: string, repoPath: string): Promise<void> {
    const stream = createReadStream(absolutePath, {
      highWaterMark: Math.min(64 * 1024, this.maxLineScanBytes)
    });
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let overlap = "";
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const text = overlap + decodeUtf8Chunk(decoder, buffer);
        if (buffer.includes(0)) {
          throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file content blocked: ${repoPath}`);
        }
        if (this.scanner.hasSecretValue(text)) {
          throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Sensitive content blocked: ${repoPath}`);
        }
        overlap = text.slice(-8192);
      }
      const finalText = overlap + finishUtf8Decode(decoder);
      if (this.scanner.hasSecretValue(finalText)) {
        throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Sensitive content blocked: ${repoPath}`);
      }
    } finally {
      if (!stream.destroyed) stream.destroy();
    }
  }
}

function validateSelectors(options: FetchFileOptions): void {
  const hasLines = options.start_line !== undefined || options.end_line !== undefined;
  if (options.start_line !== undefined && (!Number.isInteger(options.start_line) || options.start_line <= 0)) {
    throw new RepoReaderError("VALIDATION_ERROR", "start_line must be a positive integer.");
  }
  if (options.end_line !== undefined && (!Number.isInteger(options.end_line) || options.end_line <= 0)) {
    throw new RepoReaderError("VALIDATION_ERROR", "end_line must be a positive integer.");
  }
  if (options.start_line !== undefined && options.end_line !== undefined && options.end_line < options.start_line) {
    throw new RepoReaderError("VALIDATION_ERROR", "end_line must be greater than or equal to start_line.");
  }
  if (options.byte_offset !== undefined && (!Number.isInteger(options.byte_offset) || options.byte_offset < 0)) {
    throw new RepoReaderError("VALIDATION_ERROR", "byte_offset must be a non-negative integer.");
  }
  if (options.max_bytes !== undefined && (!Number.isInteger(options.max_bytes) || options.max_bytes <= 0)) {
    throw new RepoReaderError("VALIDATION_ERROR", "max_bytes must be a positive integer.");
  }
  if (options.byte_offset !== undefined && hasLines) {
    throw new RepoReaderError("VALIDATION_ERROR", "byte_offset cannot be combined with line selectors.");
  }
  if (options.cursor !== undefined && (hasLines || options.byte_offset !== undefined)) {
    throw new RepoReaderError("VALIDATION_ERROR", "cursor cannot be combined with line or byte selectors.");
  }
  if (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 4096)) {
    throw new RepoReaderError("VALIDATION_ERROR", "cursor must contain between 1 and 4096 characters.");
  }
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new RepoReaderError("BINARY_FILE_REJECTED", "File content is not valid UTF-8.");
  }
}

function toSafeNumber(value: number | bigint, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue) && field === "file size") {
    throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", "File size is too large to page safely.");
  }
  if (!Number.isFinite(numberValue)) {
    throw new RepoReaderError("INTERNAL_ERROR", `Invalid ${field}.`);
  }
  return numberValue;
}

function decodeUtf8Chunk(decoder: TextDecoder, buffer: Buffer): string {
  try {
    return decoder.decode(buffer, { stream: true });
  } catch {
    throw new RepoReaderError("BINARY_FILE_REJECTED", "File content is not valid UTF-8.");
  }
}

function finishUtf8Decode(decoder: TextDecoder): string {
  try {
    return decoder.decode();
  } catch {
    throw new RepoReaderError("BINARY_FILE_REJECTED", "File content is not valid UTF-8.");
  }
}

function lineScanLimitError(maxLineScanBytes: number): RepoReaderError {
  return new RepoReaderError(
    "SIZE_LIMIT_EXCEEDED",
    `Line scan exceeds max_line_scan_bytes (${maxLineScanBytes}); use byte_offset pagination or raise the configured limit.`
  );
}

function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

function requireCursorPosition(value: number | undefined, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new RepoReaderError("INTERNAL_ERROR", `Missing ${field} for truncated file result.`);
  }
  return Number(value);
}

function encodeCursor(cursor: FileCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAndValidateCursor(
  encoded: string,
  repoPath: string,
  fileSize: number,
  mtimeMs: number
): FileCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new RepoReaderError("VALIDATION_ERROR", "Invalid file cursor.");
  }

  if (!isFileCursor(parsed) || parsed.path !== repoPath) {
    throw new RepoReaderError("VALIDATION_ERROR", "Cursor does not match the requested file.");
  }
  if (parsed.file_size_bytes !== fileSize || parsed.mtime_ms !== mtimeMs) {
    throw new RepoReaderError("STALE_CURSOR", `File changed since the cursor was created: ${repoPath}`, { retryable: true });
  }
  if (parsed.mode === "bytes" && Number(parsed.next_byte_offset) > fileSize) {
    throw new RepoReaderError("VALIDATION_ERROR", "Cursor byte offset is beyond the end of the file.");
  }
  if (parsed.mode === "lines" && parsed.end_line !== undefined && Number(parsed.next_line) > parsed.end_line) {
    throw new RepoReaderError("VALIDATION_ERROR", "Cursor line position is beyond its requested end line.");
  }
  return parsed;
}

function isFileCursor(value: unknown): value is FileCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<FileCursor>;
  if (
    cursor.version !== 1
    || typeof cursor.path !== "string"
    || cursor.path.length === 0
    || (cursor.mode !== "bytes" && cursor.mode !== "lines")
    || !Number.isInteger(cursor.file_size_bytes)
    || Number(cursor.file_size_bytes) < 0
    || typeof cursor.mtime_ms !== "number"
    || !Number.isFinite(cursor.mtime_ms)
    || cursor.mtime_ms < 0
  ) return false;

  if (cursor.mode === "bytes") {
    return Number.isInteger(cursor.next_byte_offset) && Number(cursor.next_byte_offset) >= 0;
  }
  return (
    Number.isInteger(cursor.next_line)
    && Number(cursor.next_line) > 0
    && (
      cursor.end_line === undefined
      || (Number.isInteger(cursor.end_line) && Number(cursor.end_line) >= Number(cursor.next_line))
    )
  );
}
