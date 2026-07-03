import { createHash } from "node:crypto";
import path from "node:path";
import { RepoReaderError } from "../runtime/errors.js";
import { readFilePrefix } from "./bounded-read.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type FetchImageOptions = {
  path: string;
  max_bytes?: number;
  override_default_excludes?: boolean;
};

export type ImageReadResult = {
  path: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp";
  size_bytes: number;
  sha256: string;
  warnings: string[];
  data: string;
};

export class ImageReader {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly sandbox: PathSandbox) {}

  async read(options: FetchImageOptions): Promise<ImageReadResult> {
    const resolved = await this.sandbox.resolve(options.path);
    if (!resolved.stat.isFile()) {
      throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Not a regular file: ${resolved.repoPath}`);
    }

    const warnings: string[] = ["Image pixels are not scanned for embedded secrets or personal data."];
    if (this.ignoreEngine.isIgnored(resolved.repoPath) && !options.override_default_excludes) {
      throw new RepoReaderError("DEFAULT_EXCLUDE_BLOCKED", `Path is excluded by default: ${resolved.repoPath}`);
    }
    if (this.ignoreEngine.isIgnored(resolved.repoPath) && options.override_default_excludes) {
      warnings.push(`Read default-excluded image path with override: ${resolved.repoPath}`);
    }
    if (this.ignoreEngine.isSensitiveCandidate(resolved.repoPath)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret candidate blocked: ${resolved.repoPath}`);
    }

    const maxBytes = Math.min(options.max_bytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
    const { buffer, truncated } = await readFilePrefix(resolved.absolutePath, maxBytes);
    if (truncated) {
      throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `Image exceeds max_bytes: ${resolved.repoPath}`);
    }

    const mimeType = detectImageMimeType(resolved.repoPath, buffer);
    return {
      path: resolved.repoPath,
      mime_type: mimeType,
      size_bytes: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      warnings,
      data: buffer.toString("base64")
    };
  }
}

function detectImageMimeType(repoPath: string, buffer: Buffer): ImageReadResult["mime_type"] {
  const extension = path.extname(repoPath).toLowerCase();

  if (extension === ".png" && isPng(buffer)) return "image/png";
  if ((extension === ".jpg" || extension === ".jpeg") && isJpeg(buffer)) return "image/jpeg";
  if (extension === ".webp" && isWebp(buffer)) return "image/webp";

  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported image type: ${repoPath}`);
  }
  throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Image signature does not match file extension: ${repoPath}`);
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}
