import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { DEFAULT_EXCLUDES } from "../policies/default-excludes.js";
import { DEFAULT_LIMITS, type RuntimeLimits } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { getRepoCacheGeneration } from "../runtime/repo-cache.js";
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

type SearchResponse = {
  results: Array<SearchMatch & { before: string[]; after: string[] }>;
  matched_count: number;
  returned_count: number;
  scan_complete: boolean;
  truncated: boolean;
  next_cursor?: string;
  warnings: string[];
};
type RipgrepManyAttempt = {
  scans?: BackendScan[];
  fallbackWarning?: string;
};

type PreparedSearch = {
  options: SearchOptions;
  matcher: { column: (line: string) => number | undefined };
  maxResults: number;
  contextLines: number;
  start: number;
  stopAfter: number;
  cacheKey: string;
};

const FALLBACK_TREE_PAGE_SIZE = 512;
const RIPGREP_RETRY_MS = 30_000;
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX_ENTRIES = 512;
let ripgrepUnavailableUntil = 0;
const searchCache = new Map<string, {
  generation: number;
  expiresAt: number;
  result: SearchResponse;
}>();

export class SearchService {
  private readonly ignoreEngine = new IgnoreEngine();
  private readonly classifier = new FileClassifier(this.ignoreEngine);
  private readonly fastPathEligibility = new Map<string, boolean>();

  constructor(private readonly root: string, private readonly sandbox: PathSandbox, private readonly limits: RuntimeLimits = DEFAULT_LIMITS) {}

  async search(options: SearchOptions): Promise<SearchResponse> {
    return (await this.searchMany([options]))[0]!;
  }

  async searchMany(optionsList: SearchOptions[]): Promise<SearchResponse[]> {
    if (optionsList.length === 0) return [];
    if (!canBatchSearchOptions(optionsList)) {
      return mapWithConcurrency(optionsList, 3, (options) => this.search(options));
    }

    const generation = getRepoCacheGeneration(this.root);
    const results = new Array<SearchResponse>(optionsList.length);
    const pending: Array<{ index: number; prepared: PreparedSearch }> = [];

    for (const [index, options] of optionsList.entries()) {
      const prepared = prepareSearch(this.root, options, this.limits);
      const cached = searchCache.get(prepared.cacheKey);
      if (cached && cached.generation === generation && cached.expiresAt > Date.now()) {
        results[index] = cached.result;
      } else {
        pending.push({ index, prepared });
      }
    }

    if (pending.length === 0) return results;

    this.fastPathEligibility.clear();
    const preparedSearches = pending.map((item) => item.prepared);
    const ripgrep = await this.tryRipgrepMany(preparedSearches);
    const scans = ripgrep.scans ?? await this.searchManyWithTypescript(preparedSearches, ripgrep.fallbackWarning);
    for (const [pendingIndex, item] of pending.entries()) {
      results[item.index] = await this.finalizeSearch(item.prepared, scans[pendingIndex]!, generation);
    }
    return results;
  }

  private async finalizeSearch(
    prepared: PreparedSearch,
    scan: BackendScan,
    generation: number
  ): Promise<SearchResponse> {
    scan.matches.sort(compareMatches);

    const selected = scan.matches.slice(prepared.start, prepared.start + prepared.maxResults);
    const results = await this.addContext(selected, prepared.contextLines);
    const nextIndex = prepared.start + results.length;
    const truncated = scan.matches.length > nextIndex;
    const warnings = [...scan.warnings];
    if (!scan.scanComplete && !warnings.includes("MATCH_COUNT_LOWER_BOUND")) {
      warnings.push("MATCH_COUNT_LOWER_BOUND");
    }

    const result = {
      results,
      matched_count: scan.matches.length,
      returned_count: results.length,
      scan_complete: scan.scanComplete,
      truncated,
      ...(truncated ? { next_cursor: String(nextIndex) } : {}),
      warnings
    };
    searchCache.set(prepared.cacheKey, {
      generation,
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      result
    });
    trimSearchCache();
    return result;
  }

  private async tryRipgrepMany(prepared: PreparedSearch[]): Promise<RipgrepManyAttempt> {
    if (Date.now() < ripgrepUnavailableUntil) {
      return { fallbackWarning: "RIPGREP_UNAVAILABLE_FALLBACK" };
    }

    return new Promise((resolve) => {
      const args = buildRipgrepManyArgs(prepared);
      const child = spawn("rg", args, {
        cwd: this.root,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const scans = prepared.map<BackendScan>(() => ({ matches: [], scanComplete: true, warnings: [] }));
      let pendingOutput = "";
      let intentionallyStopped = false;
      let settled = false;

      const finish = (attempt: RipgrepManyAttempt): void => {
        if (settled) return;
        settled = true;
        resolve(attempt);
      };

      const processLine = (line: string): void => {
        if (!line || intentionallyStopped) return;
        const match = parseRipgrepMatch(line);
        if (!match) return;

        for (const [index, search] of prepared.entries()) {
          const scan = scans[index]!;
          if (scan.matches.length >= search.stopAfter || !this.isAllowedFastPath(match.path, search.options)) continue;
          const column = search.matcher.column(match.text);
          if (column === undefined) continue;
          scan.matches.push({ ...match, column });
          if (scan.matches.length >= search.stopAfter) scan.scanComplete = false;
        }

        if (scans.every((scan, index) => scan.matches.length >= prepared[index]!.stopAfter)) {
          intentionallyStopped = true;
          child.kill();
        }
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        pendingOutput += chunk.toString();
        let newline = pendingOutput.indexOf("\n");
        while (newline >= 0) {
          processLine(pendingOutput.slice(0, newline));
          pendingOutput = pendingOutput.slice(newline + 1);
          newline = pendingOutput.indexOf("\n");
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
        if (pendingOutput) processLine(pendingOutput);
        if (intentionallyStopped || code === 0 || code === 1) {
          finish({ scans });
          return;
        }
        finish({ fallbackWarning: "RIPGREP_FAILED_FALLBACK" });
      });
    });
  }

  private isAllowedFastPath(path: string, options: SearchOptions): boolean {
    const normalized = normalizeRepoPath(path);
    const cacheKey = `${batchScopeKey(options)}\u0000${normalized}`;
    const cached = this.fastPathEligibility.get(cacheKey);
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
    this.fastPathEligibility.set(cacheKey, allowed);
    return allowed;
  }

  private async searchManyWithTypescript(
    prepared: PreparedSearch[],
    fallbackWarning?: string
  ): Promise<BackendScan[]> {
    const treeService = new RepoTreeService(this.root, this.sandbox, this.limits);
    const scans = prepared.map<BackendScan>(() => ({
      matches: [],
      scanComplete: true,
      warnings: [fallbackWarning ?? "SEARCH_BACKEND_TYPESCRIPT"]
    }));
    let treeCursor: string | undefined;

    while (true) {
      const tree = await treeService.tree({
        include_files: true,
        respect_default_excludes: true,
        page_size: FALLBACK_TREE_PAGE_SIZE,
        cursor: treeCursor
      });

      let allSearchesSaturated = false;
      for (const entry of tree.entries) {
        if (entry.type !== "file" || this.ignoreEngine.isSensitiveCandidate(entry.path)) continue;
        const eligibleSearches = prepared
          .map((search, index) => ({ search, index }))
          .filter(({ search, index }) => scans[index]!.matches.length < search.stopAfter)
          .filter(({ search }) => isIncluded(entry.path, search.options.include_globs))
          .filter(({ search }) => !isExcludedByGlob(entry.path, search.options.exclude_globs));
        if (eligibleSearches.length === 0) continue;

        const resolved = await this.sandbox.resolve(entry.path);
        const classification = await this.classifier.classify(entry.path, resolved.absolutePath, resolved.stat);
        if (classification.is_binary) continue;
        const lines = (await readFile(resolved.absolutePath, "utf8")).split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const text = lines[lineIndex] ?? "";
          for (const { search, index } of eligibleSearches) {
            const scan = scans[index]!;
            if (scan.matches.length >= search.stopAfter) continue;
            const column = search.matcher.column(text);
            if (column === undefined) continue;
            scan.matches.push({ path: entry.path, line: lineIndex + 1, column, text });
            if (scan.matches.length >= search.stopAfter) scan.scanComplete = false;
          }
        }

        allSearchesSaturated = scans.every((scan, index) => scan.matches.length >= prepared[index]!.stopAfter);
        if (allSearchesSaturated) break;
      }

      if (allSearchesSaturated || !tree.truncated) break;
      treeCursor = tree.next_cursor;
      if (!treeCursor) {
        for (const scan of scans) scan.scanComplete = false;
        break;
      }
    }

    return scans;
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

function buildRipgrepManyArgs(prepared: PreparedSearch[]): string[] {
  const first = prepared[0]!.options;
  const args = [
    "--json",
    "--hidden",
    "--no-ignore",
    "--no-messages",
    "--ignore-case",
    "--sort=path",
    "--color=never"
  ];
  if (first.mode !== "regex") args.push("--fixed-strings");
  for (const glob of DEFAULT_EXCLUDES) args.push("--glob", `!${glob}`);
  for (const glob of first.include_globs ?? []) args.push("--glob", glob);
  for (const glob of first.exclude_globs ?? []) args.push("--glob", `!${glob}`);
  for (const search of prepared) args.push("-e", search.options.query);
  args.push("--", ".");
  return args;
}

function prepareSearch(root: string, options: SearchOptions, limits: RuntimeLimits): PreparedSearch {
  const matcher = createMatcher(options);
  const maxResults = Math.min(options.max_results ?? limits.max_search_results, limits.max_search_results);
  const contextLines = Math.min(options.context_lines ?? 0, 5);
  const start = parseCursor(options.cursor);
  return {
    options,
    matcher,
    maxResults,
    contextLines,
    start,
    stopAfter: start + maxResults + 1,
    cacheKey: searchCacheKey(root, options, maxResults, contextLines, start)
  };
}

function canBatchSearchOptions(optionsList: SearchOptions[]): boolean {
  const first = optionsList[0];
  if (!first) return true;
  const scope = batchScopeKey(first);
  return optionsList.every((options) => batchScopeKey(options) === scope);
}

function batchScopeKey(options: SearchOptions): string {
  return JSON.stringify({
    mode: options.mode ?? "literal",
    include_globs: options.include_globs ?? [],
    exclude_globs: options.exclude_globs ?? []
  });
}

async function mapWithConcurrency<TInput, TResult>(
  values: TInput[],
  concurrency: number,
  map: (value: TInput) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function searchCacheKey(
  root: string,
  options: SearchOptions,
  maxResults: number,
  contextLines: number,
  start: number
): string {
  return `${root}\u0000${JSON.stringify({
    query: options.query,
    mode: options.mode ?? "literal",
    include_globs: options.include_globs ?? [],
    exclude_globs: options.exclude_globs ?? [],
    maxResults,
    contextLines,
    start
  })}`;
}

function trimSearchCache(): void {
  while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value as string | undefined;
    if (!oldest) return;
    searchCache.delete(oldest);
  }
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
