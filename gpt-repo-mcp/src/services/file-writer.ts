import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import type { WriteFileActionSchema, WriteFileInput, WriteFileResult, WriteGroupedEditChange } from "../contracts/write.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { invalidateRepoCaches } from "../runtime/repo-cache.js";
import { normalizeRepoPath } from "./ignore-engine.js";
import { invalidateFileClassification } from "./file-classifier.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { SecretScanner } from "./secret-scanner.js";
import { WritePolicy } from "./write-policy.js";
import type { z } from "zod";

type WriteAction = z.infer<typeof WriteFileActionSchema>;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type ExistingTarget = {
  exists: true;
  repoPath: string;
  absolutePath: string;
  oldContent: Buffer;
  oldText: string;
  oldSha256: string;
};

type NewTarget = {
  exists: false;
  repoPath: string;
  absolutePath: string;
};

type WriteTarget = ExistingTarget | NewTarget;

type ComputedWrite = {
  action: WriteAction;
  nextText: string;
  nextContent: Buffer;
};

export type WriteGroupedEditResult = Omit<WriteFileResult, "action" | "summary"> & {
  action: "edit";
  summary: string;
};

export type PreparedWriteOperation = {
  result: WriteFileResult | WriteGroupedEditResult;
  absolutePath: string;
  nextContent: Buffer;
  createDirs: boolean;
};

export class FileWriter {
  private readonly contentScanner = new SecretScanner();

  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    private readonly policy: WritePolicy
  ) {}

  async write(input: Omit<WriteFileInput, "repo_id">): Promise<WriteFileResult> {
    const prepared = await this.prepareWrite(input);
    return this.commitPrepared(prepared) as Promise<WriteFileResult>;
  }

  async writeGroupedEdit(input: Omit<WriteGroupedEditChange, "type"> & { dry_run?: boolean }): Promise<WriteGroupedEditResult> {
    const prepared = await this.prepareGroupedEdit(input);
    return this.commitPrepared(prepared) as Promise<WriteGroupedEditResult>;
  }

  async prepareWrite(input: Omit<WriteFileInput, "repo_id">): Promise<PreparedWriteOperation> {
    const action = input.action ?? "write";
    const repoPath = validateRepoPath(input.path);

    this.policy.assertAllowed({ path: repoPath, bytes: 0, action });

    const createDirs = Boolean(input.create_dirs);
    const target = await this.resolveTarget(repoPath, createDirs);
    const computed = this.computeNextContent(action, input, target);

    if (this.contentScanner.hasSecretValue(computed.nextText)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret content blocked: ${repoPath}`);
    }
    this.policy.assertAllowed({ path: repoPath, bytes: computed.nextContent.byteLength, action });

    const oldSha256 = target.exists ? target.oldSha256 : undefined;
    const newSha256 = sha256(computed.nextContent);
    const created = !target.exists;
    const changed = !target.exists || oldSha256 !== newSha256;
    const dryRun = input.dry_run ?? false;
    const bytesWritten = dryRun || !changed ? 0 : computed.nextContent.byteLength;

    return {
      result: {
        ok: true,
        path: repoPath,
        action,
        dry_run: dryRun,
        changed,
        created,
        bytes_written: bytesWritten,
        ...(oldSha256 ? { old_sha256: oldSha256 } : {}),
        new_sha256: newSha256,
        summary: summarize(repoPath, action, created, changed, dryRun),
        warnings: []
      },
      absolutePath: target.absolutePath,
      nextContent: computed.nextContent,
      createDirs
    };
  }

  async prepareGroupedEdit(
    input: Omit<WriteGroupedEditChange, "type"> & { dry_run?: boolean }
  ): Promise<PreparedWriteOperation> {
    const repoPath = validateRepoPath(input.path);

    this.policy.assertAllowed({ path: repoPath, bytes: 0, action: "edit" });

    const target = await this.resolveTarget(repoPath, false);
    if (!target.exists) {
      throw new RepoReaderError("WRITE_TARGET_MISSING", `File does not exist: ${target.repoPath}`);
    }
    if (target.oldContent.includes(0)) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file cannot be edited: ${target.repoPath}`);
    }

    const nextText = applyGroupedEdits(target.oldText, input.edits, target.repoPath);
    if (this.contentScanner.hasSecretValue(nextText)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret content blocked: ${repoPath}`);
    }
    const nextContent = Buffer.from(nextText, "utf8");
    this.policy.assertAllowed({ path: repoPath, bytes: nextContent.byteLength, action: "edit" });

    const oldSha256 = target.oldSha256;
    const newSha256 = sha256(nextContent);
    const changed = oldSha256 !== newSha256;
    const dryRun = input.dry_run ?? false;
    const bytesWritten = dryRun || !changed ? 0 : nextContent.byteLength;

    return {
      result: {
        ok: true,
        path: repoPath,
        action: "edit",
        dry_run: dryRun,
        changed,
        created: false,
        bytes_written: bytesWritten,
        old_sha256: oldSha256,
        new_sha256: newSha256,
        summary: summarizeGroupedEdit(repoPath, input.edits.length, changed, dryRun),
        warnings: []
      },
      absolutePath: target.absolutePath,
      nextContent,
      createDirs: false
    };
  }

  async commitPrepared(
    prepared: PreparedWriteOperation
  ): Promise<WriteFileResult | WriteGroupedEditResult> {
    if (prepared.result.dry_run) {
      return prepared.result;
    }

    await this.assertPreparedTargetUnchanged(prepared);
    if (!prepared.result.changed) {
      return prepared.result;
    }

    if (prepared.createDirs) {
      await this.ensureParentDirectory(prepared.result.path, true, true);
    }
    await atomicWriteFile(prepared.absolutePath, prepared.nextContent);
    invalidateFileClassification(prepared.absolutePath);
    invalidateRepoCaches(this.root);
    return prepared.result;
  }

  private async assertPreparedTargetUnchanged(prepared: PreparedWriteOperation): Promise<void> {
    if (prepared.result.created) {
      try {
        await lstat(prepared.absolutePath);
      } catch (error) {
        if (isNotFoundError(error)) return;
        throw error;
      }
      throw new RepoReaderError(
        "WRITE_TARGET_EXISTS",
        `File was created after write preparation: ${prepared.result.path}`,
        { retryable: true }
      );
    }

    const expectedSha256 = prepared.result.old_sha256;
    if (!expectedSha256) {
      throw new RepoReaderError("INTERNAL_ERROR", `Missing prepared file hash: ${prepared.result.path}`);
    }

    let currentContent: Buffer;
    try {
      currentContent = await readFile(prepared.absolutePath);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new RepoReaderError(
          "WRITE_TARGET_MISSING",
          `File was removed after write preparation: ${prepared.result.path}`,
          { retryable: true }
        );
      }
      throw error;
    }

    if (sha256(currentContent) !== expectedSha256) {
      throw new RepoReaderError(
        "WRITE_STALE_EXPECTED_SHA",
        `File changed after write preparation: ${prepared.result.path}`,
        { retryable: true }
      );
    }
  }

  private computeNextContent(
    action: WriteAction,
    input: Omit<WriteFileInput, "repo_id">,
    target: WriteTarget
  ): ComputedWrite {
    if (action === "write") {
      const rawContent = requireContent(input, action);
      const content = target.exists
        ? normalizeLineEndings(rawContent, detectPreferredLineEnding(target.oldText))
        : rawContent;
      return {
        action,
        nextText: content,
        nextContent: Buffer.from(content, "utf8")
      };
    }

    if (!target.exists) {
      throw new RepoReaderError("WRITE_TARGET_MISSING", `File does not exist: ${target.repoPath}`);
    }
    if (target.oldContent.includes(0)) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file cannot be edited: ${target.repoPath}`);
    }

    const lineEnding = detectPreferredLineEnding(target.oldText);
    const oldText = normalizeLineEndings(target.oldText, lineEnding);
    let nextText: string;
    if (action === "append") {
      nextText = oldText + normalizeLineEndings(requireContent(input, action), lineEnding);
    } else if (action === "prepend") {
      nextText = normalizeLineEndings(requireContent(input, action), lineEnding) + oldText;
    } else if (action === "replace") {
      const find = normalizeLineEndings(requireFind(input, action), lineEnding);
      const replace = normalizeLineEndings(requireReplace(input, action), lineEnding);
      assertFindAppearsExactlyOnce(oldText, find, target.repoPath);
      nextText = oldText.replace(find, replace);
    } else if (action === "insert_before") {
      const find = normalizeLineEndings(requireFind(input, action), lineEnding);
      assertFindAppearsExactlyOnce(oldText, find, target.repoPath);
      const index = oldText.indexOf(find);
      nextText = oldText.slice(0, index) + normalizeLineEndings(requireContent(input, action), lineEnding) + oldText.slice(index);
    } else if (action === "insert_after") {
      const find = normalizeLineEndings(requireFind(input, action), lineEnding);
      assertFindAppearsExactlyOnce(oldText, find, target.repoPath);
      const index = oldText.indexOf(find) + find.length;
      nextText = oldText.slice(0, index) + normalizeLineEndings(requireContent(input, action), lineEnding) + oldText.slice(index);
    } else {
      nextText = applyLineEdit(oldText, {
        type: action,
        start_line: input.start_line,
        end_line: input.end_line,
        content: input.content
      }, target.repoPath, lineEnding);
    }

    return { action, nextText, nextContent: Buffer.from(nextText, "utf8") };
  }
  private async resolveTarget(repoPath: string, createDirs: boolean): Promise<WriteTarget> {
    try {
      const resolved = await this.sandbox.resolve(repoPath);
      if (!resolved.stat.isFile()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Not a regular file: ${resolved.repoPath}`);
      }
      const oldContent = await readFile(resolved.absolutePath);
      const oldText = decodeUtf8(oldContent, resolved.repoPath);
      return {
        exists: true,
        repoPath: resolved.repoPath,
        absolutePath: resolved.absolutePath,
        oldContent,
        oldText,
        oldSha256: sha256(oldContent)
      };
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    await this.ensureParentDirectory(repoPath, createDirs, false);
    return {
      exists: false,
      repoPath,
      absolutePath: await resolveProspectiveTarget(this.root, repoPath)
    };
  }

  private async ensureParentDirectory(repoPath: string, createDirs: boolean, mutate: boolean): Promise<void> {
    const parentPath = posix.dirname(repoPath);
    if (parentPath === ".") {
      await assertWithinRoot(this.root, this.root);
      return;
    }

    const segments = normalizeRepoPath(parentPath).split("/").filter(Boolean);
    let currentRepoPath = "";
    let missingAncestor = false;
    for (const segment of segments) {
      currentRepoPath = currentRepoPath ? `${currentRepoPath}/${segment}` : segment;
      const absolutePath = join(this.root, currentRepoPath);

      if (missingAncestor) {
        if (mutate) {
          await mkdir(absolutePath);
          await assertWithinRoot(this.root, absolutePath);
        }
        continue;
      }

      try {
        const stat = await lstat(absolutePath);
        if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
          throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${currentRepoPath}`);
        }
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Parent is not a directory: ${currentRepoPath}`);
        }
        await assertWithinRoot(this.root, absolutePath);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        if (!createDirs) {
          throw new RepoReaderError("WRITE_PARENT_MISSING", `Parent directory does not exist: ${parentPath}`);
        }
        missingAncestor = true;
        if (mutate) {
          await mkdir(absolutePath);
          await assertWithinRoot(this.root, absolutePath);
        }
      }
    }
  }
}

async function resolveProspectiveTarget(root: string, repoPath: string): Promise<string> {
  const segments = normalizeRepoPath(repoPath).split("/").filter(Boolean);
  let currentAbsolutePath = await realpath(root);
  let segmentIndex = 0;

  for (; segmentIndex < segments.length - 1; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (!segment) continue;
    const candidatePath = join(currentAbsolutePath, segment);
    try {
      const candidateStat = await lstat(candidatePath);
      if (!candidateStat.isDirectory() && !candidateStat.isSymbolicLink()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Parent is not a directory: ${repoPath}`);
      }
      const resolvedCandidatePath = await realpath(candidatePath);
      const resolvedCandidateStat = await lstat(resolvedCandidatePath);
      if (!resolvedCandidateStat.isDirectory()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Parent is not a directory: ${repoPath}`);
      }
      currentAbsolutePath = resolvedCandidatePath;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      break;
    }
  }

  return join(currentAbsolutePath, ...segments.slice(segmentIndex));
}

function decodeUtf8(content: Buffer, repoPath: string): string {
  try {
    return textDecoder.decode(content);
  } catch {
    throw new RepoReaderError("BINARY_FILE_REJECTED", `File is not valid UTF-8: ${repoPath}`);
  }
}

function requireContent(input: Omit<WriteFileInput, "repo_id">, action: WriteAction): string {
  if (typeof input.content !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", `content is required for ${action}.`);
  }
  return input.content;
}

function requireFind(input: Omit<WriteFileInput, "repo_id">, action: WriteAction): string {
  if (typeof input.find !== "string" || input.find.length === 0) {
    throw new RepoReaderError("WRITE_FIND_REQUIRED", `find is required for ${action}.`);
  }
  return input.find;
}

function requireReplace(input: Omit<WriteFileInput, "repo_id">, action: WriteAction): string {
  if (typeof input.replace !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", `replace is required for ${action}.`);
  }
  return input.replace;
}

function assertFindAppearsExactlyOnce(text: string, find: string, repoPath: string): void {
  const first = text.indexOf(find);
  if (first === -1) {
    throw new RepoReaderError(
      "WRITE_FIND_NOT_FOUND",
      `find text was not found in ${repoPath}; re-read the target lines and prefer replace_lines, insert_before_line, or insert_after_line when line numbers are known.`
    );
  }
  if (text.indexOf(find, first + find.length) !== -1) {
    throw new RepoReaderError(
      "WRITE_FIND_NOT_UNIQUE",
      `find text appears more than once in ${repoPath}; use a more specific anchor or line-number edit.`
    );
  }
}

type LineEnding = "\n" | "\r\n";
type LineEditKind = "replace_lines" | "insert_before_line" | "insert_after_line";
type LineEditInput = {
  type: LineEditKind;
  start_line?: number;
  end_line?: number;
  content?: string;
};

function applyGroupedEdits(text: string, edits: WriteGroupedEditChange["edits"], repoPath: string): string {
  const lineEnding = detectPreferredLineEnding(text);
  let nextText = normalizeLineEndings(text, lineEnding);
  for (const edit of edits) {
    if (isLineEditKind(edit.type)) {
      nextText = applyLineEdit(nextText, {
        type: edit.type,
        start_line: edit.start_line,
        end_line: edit.end_line,
        content: edit.content
      }, repoPath, lineEnding);
      continue;
    }

    const find = normalizeLineEndings(requireGroupedFind(edit, repoPath), lineEnding);
    assertFindAppearsExactlyOnce(nextText, find, repoPath);
    if (edit.type === "replace") {
      nextText = nextText.replace(find, normalizeLineEndings(requireGroupedReplace(edit), lineEnding));
    } else if (edit.type === "insert_before") {
      const index = nextText.indexOf(find);
      nextText = nextText.slice(0, index) + normalizeLineEndings(requireGroupedContent(edit), lineEnding) + nextText.slice(index);
    } else {
      const index = nextText.indexOf(find) + find.length;
      nextText = nextText.slice(0, index) + normalizeLineEndings(requireGroupedContent(edit), lineEnding) + nextText.slice(index);
    }
  }
  return nextText;
}

function applyLineEdit(text: string, edit: LineEditInput, repoPath: string, lineEnding: LineEnding): string {
  const state = splitLineState(text, lineEnding);
  const startLine = requireStartLine(edit, repoPath);
  assertLineExists(startLine, state.lines.length, repoPath);

  const contentLines = lineEditContentToLines(requireLineEditContent(edit, repoPath), lineEnding);
  if (edit.type === "replace_lines") {
    const endLine = edit.end_line ?? startLine;
    if (endLine < startLine) {
      throw new RepoReaderError("VALIDATION_ERROR", `end_line must be greater than or equal to start_line for ${repoPath}.`);
    }
    assertLineExists(endLine, state.lines.length, repoPath);
    state.lines.splice(startLine - 1, endLine - startLine + 1, ...contentLines);
  } else {
    const insertIndex = edit.type === "insert_before_line" ? startLine - 1 : startLine;
    state.lines.splice(insertIndex, 0, ...contentLines);
  }

  return joinLineState(state.lines, state.trailingNewline, lineEnding);
}

function detectPreferredLineEnding(text: string): LineEnding {
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const lfCount = (text.match(/\n/g) ?? []).length - crlfCount;
  return crlfCount > lfCount ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string, lineEnding: LineEnding): string {
  return text.replace(/\r\n|\r|\n/g, lineEnding);
}

function splitLineState(text: string, lineEnding: LineEnding): { lines: string[]; trailingNewline: boolean } {
  const normalized = normalizeLineEndings(text, lineEnding);
  const trailingNewline = normalized.endsWith(lineEnding);
  const body = trailingNewline ? normalized.slice(0, -lineEnding.length) : normalized;
  if (body.length === 0) {
    return { lines: trailingNewline ? [""] : [], trailingNewline };
  }
  return { lines: body.split(lineEnding), trailingNewline };
}

function joinLineState(lines: string[], trailingNewline: boolean, lineEnding: LineEnding): string {
  if (lines.length === 0) return "";
  return `${lines.join(lineEnding)}${trailingNewline ? lineEnding : ""}`;
}

function lineEditContentToLines(content: string, lineEnding: LineEnding): string[] {
  const normalized = normalizeLineEndings(content, lineEnding);
  const body = normalized.endsWith(lineEnding) ? normalized.slice(0, -lineEnding.length) : normalized;
  return body.length === 0 ? [] : body.split(lineEnding);
}

function isLineEditKind(type: string): type is LineEditKind {
  return type === "replace_lines" || type === "insert_before_line" || type === "insert_after_line";
}

function requireStartLine(input: { start_line?: number }, repoPath: string): number {
  if (!Number.isInteger(input.start_line) || Number(input.start_line) <= 0) {
    throw new RepoReaderError("VALIDATION_ERROR", `start_line is required for line edit in ${repoPath}.`);
  }
  return Number(input.start_line);
}

function assertLineExists(line: number, lineCount: number, repoPath: string): void {
  if (line > lineCount) {
    throw new RepoReaderError("VALIDATION_ERROR", `line ${line} is beyond the end of ${repoPath} (${lineCount} lines).`);
  }
}

function requireLineEditContent(edit: LineEditInput, repoPath: string): string {
  if (typeof edit.content !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", `content is required for ${edit.type} in ${repoPath}.`);
  }
  return edit.content;
}

function requireGroupedFind(edit: WriteGroupedEditChange["edits"][number], repoPath: string): string {
  if (typeof edit.find !== "string" || edit.find.length === 0) {
    throw new RepoReaderError("WRITE_FIND_REQUIRED", `find is required for grouped edit in ${repoPath}.`);
  }
  return edit.find;
}

function requireGroupedReplace(edit: WriteGroupedEditChange["edits"][number]): string {
  if (typeof edit.replace !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", "replace is required for grouped replace.");
  }
  return edit.replace;
}

function requireGroupedContent(edit: WriteGroupedEditChange["edits"][number]): string {
  if (typeof edit.content !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", `content is required for grouped ${edit.type}.`);
  }
  return edit.content;
}
function summarize(repoPath: string, action: WriteAction, created: boolean, changed: boolean, dryRun: boolean): string {
  if (!changed) {
    return `No changes for ${repoPath}.`;
  }
  if (dryRun) {
    return `Dry run would ${created ? "create" : action} ${repoPath}.`;
  }
  if (created) {
    return `Created ${repoPath}.`;
  }
  return `Updated ${repoPath}.`;
}

function summarizeGroupedEdit(repoPath: string, editCount: number, changed: boolean, dryRun: boolean): string {
  if (!changed) {
    return `No changes for ${repoPath}.`;
  }
  if (dryRun) {
    return `Dry run would apply ${editCount} ${editCount === 1 ? "edit" : "edits"} to ${repoPath}.`;
  }
  return `Applied ${editCount} ${editCount === 1 ? "edit" : "edits"} to ${repoPath}.`;
}

async function atomicWriteFile(path: string, content: Buffer): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.repo-write-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { flag: "wx" });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertWithinRoot(root: string, target: string): Promise<void> {
  const [rootReal, targetReal] = await Promise.all([
    realpath(root),
    realpath(target)
  ]);
  const rel = relative(resolve(rootReal), resolve(targetReal));
  if (rel !== "" && (rel.startsWith("..") || rel.includes(`..${sep}`))) {
    throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", `Path escapes approved repository: ${dirname(target)}`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
  );
}
