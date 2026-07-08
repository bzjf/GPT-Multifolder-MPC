import { stat as readStat } from "node:fs/promises";
import { extname } from "node:path";
import { IgnoreEngine } from "./ignore-engine.js";
import { readFilePrefix } from "./bounded-read.js";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".md": "markdown",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".css": "css",
  ".html": "html",
  ".yml": "yaml",
  ".yaml": "yaml"
};

const CLASSIFICATION_CACHE_TTL_MS = 5_000;
const CLASSIFICATION_CACHE_MAX_ENTRIES = 4_096;
const binaryCache = new Map<string, {
  size: number;
  mtimeMs: number;
  isBinary: boolean;
  expiresAt: number;
}>();

export type FileClassification = {
  path: string;
  language?: string;
  is_binary: boolean;
  is_secret_candidate: boolean;
  is_generated: boolean;
};

export type FileStatHint = {
  size: number | bigint;
  mtimeMs: number | bigint;
};

export class FileClassifier {
  constructor(private readonly ignoreEngine = new IgnoreEngine()) {}

  async classify(repoPath: string, absolutePath: string, hint?: FileStatHint): Promise<FileClassification> {
    const metadata = hint ?? await readStat(absolutePath);
    const size = typeof metadata.size === "bigint" ? Number(metadata.size) : metadata.size;
    const mtimeMs = typeof metadata.mtimeMs === "bigint" ? Number(metadata.mtimeMs) : metadata.mtimeMs;
    const cached = binaryCache.get(absolutePath);
    const now = Date.now();
    let isBinary: boolean;

    if (
      cached
      && cached.expiresAt > now
      && cached.size === size
      && cached.mtimeMs === mtimeMs
    ) {
      isBinary = cached.isBinary;
    } else {
      isBinary = await isBinaryFile(absolutePath);
      binaryCache.set(absolutePath, {
        size,
        mtimeMs,
        isBinary,
        expiresAt: now + CLASSIFICATION_CACHE_TTL_MS
      });
      trimBinaryCache(now);
    }

    return {
      path: repoPath,
      language: LANGUAGE_BY_EXT[extname(repoPath).toLowerCase()],
      is_binary: isBinary,
      is_secret_candidate: this.ignoreEngine.isSensitiveCandidate(repoPath),
      is_generated: this.ignoreEngine.isIgnored(repoPath)
    };
  }
}

function trimBinaryCache(now: number): void {
  for (const [path, entry] of binaryCache) {
    if (entry.expiresAt <= now) binaryCache.delete(path);
  }
  while (binaryCache.size > CLASSIFICATION_CACHE_MAX_ENTRIES) {
    const oldest = binaryCache.keys().next().value as string | undefined;
    if (!oldest) return;
    binaryCache.delete(oldest);
  }
}

export function invalidateFileClassification(absolutePath: string): void {
  binaryCache.delete(absolutePath);
}

async function isBinaryFile(absolutePath: string): Promise<boolean> {
  const { buffer } = await readFilePrefix(absolutePath, 4096);
  return buffer.includes(0);
}
