import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { DEFAULT_EXCLUDES } from "../policies/default-excludes.js";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { FileClassifier } from "./file-classifier.js";
import { isExcludedByGlob, matchesGlob } from "./glob-service.js";
import { IgnoreEngine, normalizeRepoPath } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";
import { RepoTreeService } from "./repo-tree-service.js";

export type SearchOptions = {
  query: string;
  mode?: "literal" | "regex";
  include_globs?: string[];
  exclude_globs?: string[];
  context_lines?: number;
  max_results?: number;
  cursor?: string;
};

type SearchMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
};

type BackendScan = {
  matches: SearchMatch[];
  scanComplete: boolean;
  warnings: string[];
};

type RipgrepAttempt = {
  scan?: BackendScan;
  fallbackWarning?: string;
};

const FALLBACK_TREE_PAGE_SIZE = 512;
const RIPGREP_RETRY_MS = 30_000;
let ripgrepUnavailableUntil = 0;

export class SearchService {
  private readonly ignoreEngine = new IgnoreEngine();
  private readonly classifier = new FileClassifier(this.ignoreEngine);
  private readonly fastPathEligibility = new Map<string, boolean>();

  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async search(options: SearchOptions) {
    this.fastPathEligibility.clear();
    const matcher = createMatcher(options);
    const maxResults = Math.min(options.max_results ?? DEFAULT_LIMITS.max_search_results, DEFAULT_LIMITS.max_search_results);
    const contextLines = Math.min(options.context_lines ?? 0, 5);
    const start = parseCursor(options.cursor);
    const stopAfter = start + maxResults + 1;

    const ripgrep = await this.tryRipgrep(options, stopAfter);
    const scan = ripgrep.scan ?? await this.searchWithTypescript(options, matcher, stopAfter, ripgrep.fallbackWarning);
    scan.matches.sort(compareMatches);

    const selected = scan.matches.slice(start, start + maxResults);
    const results = await this.addContext(selected, contextLines);
    const nextIndex = start + results.length;
    const truncated = scan.matches.length > nextIndex;
    const warnings = [...scan.warnings];
    if (!scan.scanComplete && !warnings.includes("MATCH_COUNT_LOWER_BOUND")) {
      warnings.push("MATCH_COUNT_LOWER_BOUND");
    }

    return {
      results,
      matched_count: scan.matches.length,
      returned_count: results.length,
      scan_complete: scan.scanComplete,
      truncated,
      ...(truncated ? { next_cursor: String(nextIndex) } : {}),
      warnings
    };
  }

  private async tryRipgrep(options: SearchOptions, stopAfter: number): Promise<RipgrepAttempt> {
    if (Date.now() < ripgrepUnavailableUntil) {
      return { fallbackWarning: "RIPGREP_UNAVAILABLE_FALLBACK" };
    }

    return new Promise((resolve) => {
      const args = buildRipgrepArgs(options);
      const child = spawn("rg", args, {
        cwd: this.root,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const matches: SearchMatch[] = [];
      let pending = "";
      let intentionallyStopped = false;
      let settled = false;

      const finish = (attempt: RipgrepAttempt): void => {
        if (settled) return;
        settled = true;
        resolve(attempt);
      };

      const processLine = (line: string): void => {
        if (!line || intentionallyStopped) return;
        const match = parseRipgrepMatch(line);
        if (!match || !this.isAllowedFastPath(match.path, options)) return;
        matches.push(match);
        if (matches.length >= stopAfter) {
          intentionallyStopped = true;
          child.kill();
        }
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        pending += chunk.toString();
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          processLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      });

      child.stderr?.resume();
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          ripgrepUnavailableUntil = Date.now() + RIPGREP_RETRY_MS;
          finish({ fallbackWarning: "RIPGREP_UNAVAILABLE_FALLBACK" });
          return;
        }
        finish({ fallbackWarning: "RIPGREP_FAILED_FALLBACK" });
      });
      child.on("close", (code) => {
        if (settled) return;
        if (pending) processLine(pending);
        if (intentionallyStopped) {
          finish({ scan: { matches, scanComplete: false, warnings: [] } });
          return;
        }
        if (code === 0 || code === 1) {
          finish({ scan: { matches, scanComplete: true, warnings: [] } });
          return;
        }
        finish({ fallbackWarning: "RIPGREP_FAILED_FALLBACK" });
      });
    });
  }

  private isAllowedFastPath(path: string, options: SearchOptions): boolean {
    const normalized = normalizeRepoPath(path);
    const cached = this.fastPathEligibility.get(normalized);
    if (cached !== undefined) return cached;

    const allowed = Boolean(normalized)
      && !isAbsolute(normalized)
      && normalized !== ".."
      && !normalized.startsWith("../")
      && !this.ignoreEngine.isSensitiveCandidate(normalized)
      && !this.ignoreEngine.isIgnored(normalized)
      && isIncluded(normalized, options.include_globs)
      && !isExcludedByGlob(normalized, options.exclude_globs)
      && !isInsideNestedRepository(this.root, normalized);
    this.fastPathEligibility.set(normalized, allowed);
    return allowed;
  }

  private async searchWithTypescript(
    options: SearchOptions,
    matcher: { column: (line: string) => number | undefined },
    stopAfter: number,
    fallbackWarning?: string
  ): Promise<BackendScan> {
    const treeService = new RepoTreeService(this.root, this.sandbox);
    const matches: SearchMatch[] = [];
    let treeCursor: string | undefined;
    let scanComplete = true;

    while (matches.length < stopAfter) {
      const tree = await treeService.tree({
        include_files: true,
        respect_default_excludes: true,
        page_size: FALLBACK_TREE_PAGE_SIZE,
        cursor: treeCursor
      });

      for (const entry of tree.entries) {
        if (entry.type !== "file") continue;
        if (!isIncluded(entry.path, options.include_globs) || isExcludedByGlob(entry.path, options.exclude_globs)) continue;
        if (this.ignoreEngine.isSensitiveCandidate(entry.path)) continue;

        const resolved = await this.sandbox.resolve(entry.path);
        const classification = await this.classifier.classify(entry.path, resolved.absolutePath, resolved.stat);
        if (classification.is_binary) continue;
        const text = await readFile(resolved.absolutePath, "utf8");
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const lineText = lines[index] ?? "";
          const column = matcher.column(lineText);
          if (column === undefined) continue;
          matches.push({ path: entry.path, line: index + 1, column, text: lineText });
          if (matches.length >= stopAfter) {
            scanComplete = false;
            break;
          }
        }
        if (!scanComplete) break;
      }

      if (!scanComplete || !tree.truncated) break;
      treeCursor = tree.next_cursor;
      if (!treeCursor) {
        scanComplete = false;
        break;
      }
    }

    return {
      matches,
      scanComplete,
      warnings: [fallbackWarning ?? "SEARCH_BACKEND_TYPESCRIPT"]
    };
  }

  private async addContext(matches: SearchMatch[], contextLines: number) {
    if (contextLines === 0) {
      return matches.map((match) => ({ ...match, before: [], after: [] }));
    }

    const linesByPath = new Map<string, string[]>();
    for (const path of new Set(matches.map((match) => match.path))) {
      const resolved = await this.sandbox.resolve(path);
      linesByPath.set(path, (await readFile(resolved.absolutePath, "utf8")).split(/\r?\n/));
    }

    return matches.map((match) => {
      const lines = linesByPath.get(match.path) ?? [];
      const index = match.line - 1;
      return {
        ...match,
        text: lines[index] ?? match.text,
        before: lines.slice(Math.max(0, index - contextLines), index),
        after: lines.slice(index + 1, index + 1 + contextLines)
      };
    });
  }
}

function buildRipgrepArgs(options: SearchOptions): string[] {
  const args = [
    "--json",
    "--hidden",
    "--no-ignore",
    "--no-messages",
    "--ignore-case",
    "--sort=path",
    "--color=never"
  ];
  if (options.mode !== "regex") args.push("--fixed-strings");
  for (const glob of DEFAULT_EXCLUDES) args.push("--glob", `!${glob}`);
  for (const glob of options.include_globs ?? []) args.push("--glob", glob);
  for (const glob of options.exclude_globs ?? []) args.push("--glob", `!${glob}`);
  args.push("--", options.query, ".");
  return args;
}

function parseRipgrepMatch(line: string): SearchMatch | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object") return undefined;
  const record = event as {
    type?: string;
    data?: {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: Array<{ start?: number }>;
    };
  };
  if (record.type !== "match") return undefined;
  const path = record.data?.path?.text;
  const rawText = record.data?.lines?.text;
  const lineNumber = record.data?.line_number;
  const byteColumn = record.data?.submatches?.[0]?.start;
  if (
    typeof path !== "string"
    || typeof rawText !== "string"
    || typeof lineNumber !== "number"
    || !Number.isInteger(lineNumber)
    || typeof byteColumn !== "number"
    || !Number.isInteger(byteColumn)
  ) {
    return undefined;
  }
  const text = rawText.replace(/\r?\n$/, "");
  const prefix = Buffer.from(text, "utf8").subarray(0, byteColumn).toString("utf8");
  return {
    path: normalizeRepoPath(path).replace(/^\.\//, ""),
    line: lineNumber,
    column: prefix.length + 1,
    text
  };
}

function createMatcher(options: SearchOptions): { column: (line: string) => number | undefined } {
  if (options.mode === "regex") {
    try {
      const regex = new RegExp(options.query, "i");
      return {
        column: (line: string) => {
          const index = line.search(regex);
          return index >= 0 ? index + 1 : undefined;
        }
      };
    } catch {
      throw new RepoReaderError("VALIDATION_ERROR", "Invalid regex query.");
    }
  }

  const query = options.query.toLowerCase();
  return {
    column: (line: string) => {
      const index = line.toLowerCase().indexOf(query);
      return index >= 0 ? index + 1 : undefined;
    }
  };
}

function isIncluded(path: string, includeGlobs: string[] = []): boolean {
  return includeGlobs.length === 0 || includeGlobs.some((glob) => matchesGlob(path, glob));
}

function isInsideNestedRepository(root: string, repoPath: string): boolean {
  const directory = posix.dirname(repoPath);
  if (directory === ".") return false;
  const segments = directory.split("/").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (existsSync(join(current, ".git"))) return true;
  }
  return false;
}

function parseCursor(cursor?: string): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor) || cursor.length > 32) {
    throw new RepoReaderError("VALIDATION_ERROR", "repo_search cursor must be a non-negative integer string.");
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RepoReaderError("VALIDATION_ERROR", "repo_search cursor is outside the supported integer range.");
  }
  return parsed;
}

function compareMatches(left: SearchMatch, right: SearchMatch): number {
  return left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column;
}
