import { readdir } from "node:fs/promises";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { getRepoCacheGeneration } from "../runtime/repo-cache.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";

export type TreeOptions = {
  path?: string;
  max_depth?: number;
  page_size?: number;
  include_files?: boolean;
  respect_default_excludes?: boolean;
  include_generated?: boolean;
  include_dependencies?: boolean;
  cursor?: string;
};

type TreeEntry = {
  path: string;
  type: "file" | "directory" | "nested_repo" | "submodule";
  size_bytes?: number;
};

type TreeResult = {
  entries: TreeEntry[];
  excluded_summary: Record<string, number>;
  truncated: boolean;
  scan_complete: boolean;
  next_cursor?: string;
};

type QueueItem = {
  path: string;
  depth: number;
};

type CachedTreePage = {
  generation: number;
  expiresAt: number;
  result: TreeResult;
};

const TREE_CACHE_TTL_MS = 1_500;
const TREE_CACHE_MAX_ENTRIES = 256;
const treePageCache = new Map<string, CachedTreePage>();

export class RepoTreeService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async tree(options: TreeOptions): Promise<TreeResult> {
    const start = validateRepoPath(options.path ?? ".");
    const maxDepth = Math.min(options.max_depth ?? DEFAULT_LIMITS.max_depth, DEFAULT_LIMITS.max_depth);
    const pageSize = Math.min(options.page_size ?? DEFAULT_LIMITS.max_tree_entries, DEFAULT_LIMITS.max_tree_entries);
    const cursor = parseCursor(options.cursor);
    const normalizedOptions = {
      start,
      maxDepth,
      pageSize,
      cursor,
      includeFiles: options.include_files ?? true,
      respectDefaultExcludes: options.respect_default_excludes ?? true,
      includeGenerated: options.include_generated ?? false,
      includeDependencies: options.include_dependencies ?? false
    };
    const cacheKey = `${this.root}\u0000${JSON.stringify(normalizedOptions)}`;
    const generation = getRepoCacheGeneration(this.root);
    const cached = treePageCache.get(cacheKey);
    if (cached && cached.generation === generation && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const result = await this.scanPage(normalizedOptions);
    treePageCache.set(cacheKey, {
      generation,
      expiresAt: Date.now() + TREE_CACHE_TTL_MS,
      result
    });
    trimTreeCache();
    return result;
  }

  private async scanPage(options: {
    start: string;
    maxDepth: number;
    pageSize: number;
    cursor: number;
    includeFiles: boolean;
    respectDefaultExcludes: boolean;
    includeGenerated: boolean;
    includeDependencies: boolean;
  }): Promise<TreeResult> {
    const excludedSummary: Record<string, number> = {};
    const queue = new PathMinHeap();
    queue.push({ path: options.start, depth: 0 });
    const collected: TreeEntry[] = [];
    let emittedCount = 0;

    const emit = (entry: TreeEntry): boolean => {
      emittedCount += 1;
      if (emittedCount > options.cursor) collected.push(entry);
      return collected.length >= options.pageSize + 1;
    };

    while (queue.size > 0) {
      const item = queue.pop();
      if (!item) break;
      const resolved = await this.resolveForTree(item.path, excludedSummary);
      if (!resolved) continue;

      const boundary = await this.sandbox.classifyBoundary(item.path);
      if (boundary.kind !== "normal" && item.path !== ".") {
        if (emit({ path: boundary.path, type: boundary.kind })) break;
        continue;
      }

      if (resolved.stat.isDirectory()) {
        if (item.path !== "." && emit({ path: item.path, type: "directory" })) break;
        if (item.depth >= options.maxDepth) continue;

        const children = await readdir(resolved.absolutePath, { withFileTypes: true });
        for (const child of children) {
          const childRepoPath = item.path === "." ? child.name : `${item.path}/${child.name}`;
          if (this.shouldExcludeChild(childRepoPath, options, excludedSummary)) continue;
          queue.push({ path: childRepoPath, depth: item.depth + 1 });
        }
        continue;
      }

      if (options.includeFiles && resolved.stat.isFile()) {
        if (emit({ path: item.path, type: "file", size_bytes: Number(resolved.stat.size) })) break;
      }
    }

    const truncated = collected.length > options.pageSize;
    const entries = truncated ? collected.slice(0, options.pageSize) : collected;
    return {
      entries,
      excluded_summary: excludedSummary,
      truncated,
      scan_complete: !truncated,
      ...(truncated ? { next_cursor: String(options.cursor + entries.length) } : {})
    };
  }

  private shouldExcludeChild(
    repoPath: string,
    options: {
      respectDefaultExcludes: boolean;
      includeGenerated: boolean;
      includeDependencies: boolean;
    },
    excludedSummary: Record<string, number>
  ): boolean {
    if (this.ignoreEngine.isSensitiveCandidate(repoPath)) {
      increment(excludedSummary, "secret_candidates");
      return true;
    }

    const dependency = isDependencyPath(repoPath);
    const generated = isGeneratedPath(repoPath);
    if (dependency && !options.includeDependencies) {
      increment(excludedSummary, "dependencies");
      increment(excludedSummary, "default_excludes");
      return true;
    }
    if (generated && !options.includeGenerated) {
      increment(excludedSummary, "generated");
      increment(excludedSummary, "default_excludes");
      return true;
    }

    const includedByFlag = (dependency && options.includeDependencies) || (generated && options.includeGenerated);
    if (options.respectDefaultExcludes && !includedByFlag && this.ignoreEngine.isIgnored(repoPath)) {
      increment(excludedSummary, "default_excludes");
      return true;
    }
    return false;
  }

  private async resolveForTree(
    repoPath: string,
    excludedSummary: Record<string, number>
  ): Promise<Awaited<ReturnType<PathSandbox["resolve"]>> | undefined> {
    try {
      return await this.sandbox.resolve(repoPath);
    } catch (error) {
      if (error instanceof RepoReaderError) {
        increment(excludedSummary, error.code);
        return undefined;
      }
      throw error;
    }
  }
}

class PathMinHeap {
  private readonly items: QueueItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: QueueItem): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareQueueItems(this.items[parent]!, item) <= 0) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): QueueItem | undefined {
    if (this.items.length === 0) return undefined;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length === 0 || !last) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      let child = left;
      if (right < this.items.length && compareQueueItems(this.items[right]!, this.items[left]!) < 0) {
        child = right;
      }
      if (compareQueueItems(last, this.items[child]!) <= 0) break;
      this.items[index] = this.items[child]!;
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

function compareQueueItems(left: QueueItem, right: QueueItem): number {
  return left.path.localeCompare(right.path);
}

function parseCursor(cursor?: string): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor) || cursor.length > 32) {
    throw new RepoReaderError("VALIDATION_ERROR", "repo_tree cursor must be a non-negative integer string.");
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RepoReaderError("VALIDATION_ERROR", "repo_tree cursor is outside the supported integer range.");
  }
  return parsed;
}

function increment(summary: Record<string, number>, key: string): void {
  summary[key] = (summary[key] ?? 0) + 1;
}

function trimTreeCache(): void {
  while (treePageCache.size > TREE_CACHE_MAX_ENTRIES) {
    const oldest = treePageCache.keys().next().value as string | undefined;
    if (!oldest) return;
    treePageCache.delete(oldest);
  }
}

function isGeneratedPath(repoPath: string): boolean {
  return /(^|\/)(dist|build|out|coverage)(\/|$)/.test(repoPath);
}

function isDependencyPath(repoPath: string): boolean {
  return /(^|\/)node_modules(\/|$)/.test(repoPath);
}
