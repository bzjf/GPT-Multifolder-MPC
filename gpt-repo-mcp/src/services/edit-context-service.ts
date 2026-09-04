import type { EditContextInput } from "../contracts/edit-context.contract.js";
import type { RootRegistry } from "./root-registry.js";
import { GitService } from "./git-service.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { ReadManyService, type ReadManyOptions } from "./read-many-service.js";
import { SearchService } from "./search-service.js";

type SearchResult = Awaited<ReturnType<SearchService["search"]>>;
type ReadManyResult = Awaited<ReturnType<ReadManyService["readMany"]>>;

type Candidate = {
  path: string;
  reason: string;
  source_queries: string[];
};

export class EditContextService {
  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    private readonly limits: RootRegistry["limits"]
  ) {}

  async context(options: EditContextInput) {
    const maxSearchResults = Math.min(options.max_search_results_per_query ?? 8, 20);
    const maxFiles = Math.min(options.max_files_to_read ?? 8, 20, this.limits.max_files);
    const contextLines = Math.min(options.context_lines ?? 1, 2);
    const searchQueries = normalizeQueries(options.search_queries, options.goal);
    const knownPaths = normalizeKnownPaths(options.known_paths);
    const candidateMap = new Map<string, Candidate>();
    const searches: Array<SearchResult & { query: string }> = [];
    const warnings = new Set<string>();

    for (const path of knownPaths) {
      addCandidate(candidateMap, path, "known_path", []);
    }

    const searchService = new SearchService(this.root, this.sandbox, this.limits);
    for (const query of searchQueries) {
      const result = await searchService.search({
        query,
        include_globs: options.include_globs,
        exclude_globs: options.exclude_globs,
        context_lines: contextLines,
        max_results: maxSearchResults
      });
      searches.push({ query, ...result });
      for (const warning of result.warnings) warnings.add(warning);
      for (const match of result.results) {
        addCandidate(candidateMap, match.path, `matched search query: ${query}`, [query]);
      }
    }

    const candidatePaths = [...candidateMap.keys()].slice(0, maxFiles);
    const readOptions = buildReadOptions(options, candidatePaths, maxFiles, this.limits);
    const readResult = readOptions
      ? await new ReadManyService(this.root, this.sandbox, this.limits).readMany(readOptions)
      : emptyReadMany();
    for (const file of readResult.files) {
      for (const warning of file.warnings) warnings.add(warning);
    }

    const headSha = await readHeadSha(this.root, warnings);
    const candidateList = [...candidateMap.values()];
    const nextReadPayload = readResult.truncated
      ? {
          repo_id: options.repo_id,
          ...readOptions,
          ...(readResult.next_cursor ? { cursor: readResult.next_cursor } : {})
        }
      : undefined;

    return {
      repo_id: options.repo_id,
      goal: options.goal,
      ...(headSha ? { head_sha: headSha } : {}),
      searches,
      candidate_paths: candidateList,
      files: readResult.files,
      skipped: readResult.skipped,
      matched_file_count: readResult.matched_count || candidateList.length,
      returned_file_count: readResult.returned_count,
      truncated: readResult.truncated || candidateList.length > candidatePaths.length,
      ...(readResult.next_cursor ? { next_cursor: readResult.next_cursor } : {}),
      next_tool_hints: {
        ...(nextReadPayload ? { repo_read_many: nextReadPayload } : {}),
        repo_write_changes: { repo_id: options.repo_id },
        repo_git_review: { repo_id: options.repo_id }
      },
      warnings: [...warnings]
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
    max_total_bytes: options.max_total_bytes ?? Math.min(limits.max_total_bytes, 256_000)
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
  candidates: Map<string, Candidate>,
  path: string,
  reason: string,
  sourceQueries: string[]
): void {
  const existing = candidates.get(path);
  if (!existing) {
    candidates.set(path, { path, reason, source_queries: sourceQueries });
    return;
  }

  for (const query of sourceQueries) {
    if (!existing.source_queries.includes(query)) existing.source_queries.push(query);
  }
  if (!existing.reason.includes(reason)) {
    existing.reason = `${existing.reason}; ${reason}`;
  }
}

function normalizeKnownPaths(paths: string[] = []): string[] {
  return [...new Set(paths.map((path) => validateRepoPath(path)))];
}

function normalizeQueries(queries: string[] | undefined, goal: string): string[] {
  const selected = queries && queries.length > 0 ? queries : [goal];
  return [...new Set(selected.map((query) => query.trim()).filter(Boolean))].slice(0, 5);
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
