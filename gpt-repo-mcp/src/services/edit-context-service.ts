import type { EditContextInput } from "../contracts/edit-context.contract.js";
import type { RootRegistry } from "./root-registry.js";
import { GitService } from "./git-service.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { ReadManyService, type ReadManyOptions } from "./read-many-service.js";
import { SearchService } from "./search-service.js";

type SearchResult = Awaited<ReturnType<SearchService["search"]>>;
type ReadManyResult = Awaited<ReturnType<ReadManyService["readMany"]>>;

type CandidateAccumulator = {
  path: string;
  known_path: boolean;
  source_queries: string[];
  hit_count: number;
  first_seen: number;
};

export type EditContextMetrics = {
  search_ms: number;
  read_ms: number;
  git_head_ms: number;
  result_bytes: number;
  search_backend: "ripgrep" | "typescript";
};

const DEFAULT_EDIT_CONTEXT_FILES = 8;
const DEFAULT_EDIT_CONTEXT_TOTAL_BYTES = 300_000;

export class EditContextService {
  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    private readonly limits: RootRegistry["limits"]
  ) {}

  async context(options: EditContextInput) {
    const maxSearchResults = Math.min(options.max_search_results_per_query ?? 16, this.limits.max_search_results);
    const maxFiles = Math.min(options.max_files_to_read ?? DEFAULT_EDIT_CONTEXT_FILES, this.limits.max_files);
    const contextLines = Math.min(options.context_lines ?? 0, 5);
    const searchQueries = normalizeQueries(options.search_queries, options.goal);
    const knownPaths = normalizeKnownPaths(options.known_paths);
    const candidateMap = new Map<string, CandidateAccumulator>();
    const warnings = new Set<string>();

    for (const path of knownPaths) {
      addCandidate(candidateMap, path, { knownPath: true });
    }

    const searchService = new SearchService(this.root, this.sandbox, this.limits);
    const searchStartedAt = Date.now();
    const searchResults = await searchService.searchMany(searchQueries.map((query) => ({
      query,
      include_globs: options.include_globs,
      exclude_globs: options.exclude_globs,
      context_lines: contextLines,
      max_results: maxSearchResults
    })));
    const searchMs = Date.now() - searchStartedAt;
    const searches: Array<SearchResult & { query: string }> = [];
    for (const [index, query] of searchQueries.entries()) {
      const result = searchResults[index]!;
      searches.push({ query, ...result });
      for (const warning of result.warnings) warnings.add(warning);
      for (const match of result.results) {
        addCandidate(candidateMap, match.path, { query });
      }
    }

    const rankedCandidates = [...candidateMap.values()].sort(compareCandidates);
    const candidatePaths = rankedCandidates.map((candidate) => candidate.path);
    const readOptions = buildReadOptions(options, candidatePaths, maxFiles, this.limits);
    const readStartedAt = Date.now();
    const readResult = readOptions
      ? await new ReadManyService(this.root, this.sandbox, this.limits).readMany(readOptions)
      : emptyReadMany();
    const readMs = Date.now() - readStartedAt;
    for (const file of readResult.files) {
      for (const warning of file.warnings) warnings.add(warning);
    }

    const gitHeadStartedAt = Date.now();
    const headSha = await readHeadSha(this.root, warnings);
    const gitHeadMs = Date.now() - gitHeadStartedAt;
    const candidateList = rankedCandidates.map(toCandidate);
    const selectedPaths = new Set(candidatePaths.slice(0, maxFiles));
    const returnedPaths = new Set(readResult.files.map((file) => file.path));
    const compactSearchResults = compactSearches(searches, selectedPaths, returnedPaths);
    const nextReadPayload = readResult.truncated
      ? {
          repo_id: options.repo_id,
          ...readOptions,
          ...(readResult.next_cursor ? { cursor: readResult.next_cursor } : {})
        }
      : undefined;

    const result = {
      repo_id: options.repo_id,
      goal: options.goal,
      ...(headSha ? { head_sha: headSha } : {}),
      searches: compactSearchResults,
      candidate_paths: candidateList,
      files: readResult.files,
      skipped: readResult.skipped,
      matched_file_count: Math.max(candidateList.length, readResult.matched_count),
      returned_file_count: readResult.returned_count,
      truncated: readResult.truncated,
      ...(readResult.next_cursor ? { next_cursor: readResult.next_cursor } : {}),
      next_tool_hints: {
        ...(nextReadPayload ? { repo_read_many: nextReadPayload } : {}),
        repo_write_changes: { repo_id: options.repo_id },
        repo_git_review: { repo_id: options.repo_id }
      },
      warnings: [...warnings]
    };
    return {
      result,
      metrics: {
        search_ms: searchMs,
        read_ms: readMs,
        git_head_ms: gitHeadMs,
        result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
        search_backend: detectSearchBackend(searches)
      } satisfies EditContextMetrics
    };
  }
}

function buildReadOptions(
  options: EditContextInput,
  candidatePaths: string[],
  maxFiles: number,
  limits: RootRegistry["limits"]
): ReadManyOptions | undefined {
  const budgets = {
    max_files: maxFiles,
    max_bytes_per_file: options.max_bytes_per_file ?? limits.max_bytes_per_file,
    max_total_bytes: options.max_total_bytes ?? Math.min(limits.max_total_bytes, DEFAULT_EDIT_CONTEXT_TOTAL_BYTES)
  };

  if (candidatePaths.length > 0) {
    return {
      paths: candidatePaths,
      exclude_globs: options.exclude_globs,
      ...budgets
    };
  }

  if ((options.include_globs?.length ?? 0) > 0) {
    return {
      include_globs: options.include_globs,
      exclude_globs: options.exclude_globs,
      ...budgets
    };
  }

  return undefined;
}

function addCandidate(
  candidates: Map<string, CandidateAccumulator>,
  path: string,
  source: { knownPath?: boolean; query?: string }
): void {
  const existing = candidates.get(path);
  if (!existing) {
    candidates.set(path, {
      path,
      known_path: source.knownPath === true,
      source_queries: source.query ? [source.query] : [],
      hit_count: source.query ? 1 : 0,
      first_seen: candidates.size
    });
  } else {
    if (source.knownPath) existing.known_path = true;
    if (source.query) {
      existing.hit_count += 1;
      if (!existing.source_queries.includes(source.query)) existing.source_queries.push(source.query);
    }
  }
}

function compareCandidates(left: CandidateAccumulator, right: CandidateAccumulator): number {
  return Number(right.known_path) - Number(left.known_path)
    || right.source_queries.length - left.source_queries.length
    || right.hit_count - left.hit_count
    || candidateFilePriority(right.path) - candidateFilePriority(left.path)
    || left.first_seen - right.first_seen
    || left.path.localeCompare(right.path);
}

function candidateFilePriority(path: string): number {
  if (/(^|\/)(__tests__|tests?|spec)(\/|\.|$)|\.(test|spec)\.[^/]+$/i.test(path)) return 1;
  if (/\.(c|cc|cpp|cs|go|java|js|jsx|kt|mjs|php|py|rb|rs|swift|ts|tsx|vue)$/i.test(path)) return 2;
  return 0;
}

function toCandidate(candidate: CandidateAccumulator): {
  path: string;
  reason: string;
  source_queries: string[];
} {
  const matched = candidate.hit_count > 0
    ? `matched ${candidate.hit_count} hit${candidate.hit_count === 1 ? "" : "s"} across ${candidate.source_queries.length} quer${candidate.source_queries.length === 1 ? "y" : "ies"}`
    : undefined;
  return {
    path: candidate.path,
    reason: [candidate.known_path ? "known_path" : undefined, matched].filter(Boolean).join("; "),
    source_queries: candidate.source_queries
  };
}

function compactSearches(
  searches: Array<SearchResult & { query: string }>,
  selectedPaths: Set<string>,
  returnedPaths: Set<string>
): Array<SearchResult & { query: string }> {
  return searches.map((search) => {
    const results = search.results
      .filter((match) => selectedPaths.has(match.path))
      .map((match) => returnedPaths.has(match.path) ? { ...match, before: [], after: [] } : match);
    return {
      query: search.query,
      results,
      matched_count: search.matched_count,
      returned_count: results.length,
      scan_complete: search.scan_complete,
      truncated: search.truncated || results.length < search.results.length,
      warnings: search.warnings
    };
  });
}

function detectSearchBackend(searches: Array<SearchResult & { query: string }>): "ripgrep" | "typescript" {
  return searches.some((search) => search.warnings.some((warning) =>
    warning === "SEARCH_BACKEND_TYPESCRIPT" || warning.endsWith("_FALLBACK")
  )) ? "typescript" : "ripgrep";
}

function normalizeKnownPaths(paths: string[] = []): string[] {
  return [...new Set(paths.map((path) => validateRepoPath(path)))];
}

function normalizeQueries(queries: string[] | undefined, goal: string): string[] {
  const selected = queries && queries.length > 0 ? queries : [goal];
  return [...new Set(selected.map((query) => query.trim()).filter(Boolean))].slice(0, 10);
}

function emptyReadMany(): ReadManyResult {
  return {
    files: [],
    skipped: [],
    matched_count: 0,
    returned_count: 0,
    truncated: false
  };
}

async function readHeadSha(root: string, warnings: Set<string>): Promise<string | undefined> {
  try {
    return await new GitService(root).headSha();
  } catch {
    warnings.add("GIT_HEAD_UNAVAILABLE");
    return undefined;
  }
}
