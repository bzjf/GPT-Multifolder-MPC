import { readdir } from "node:fs/promises";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
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

export class RepoTreeService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async tree(options: TreeOptions) {
    const start = validateRepoPath(options.path ?? ".");
    const maxDepth = Math.min(options.max_depth ?? DEFAULT_LIMITS.max_depth, DEFAULT_LIMITS.max_depth);
    const pageSize = Math.min(options.page_size ?? DEFAULT_LIMITS.max_tree_entries, DEFAULT_LIMITS.max_tree_entries);
    const cursor = parseCursor(options.cursor);
    const includeFiles = options.include_files ?? true;
    const respectDefaultExcludes = options.respect_default_excludes ?? true;
    const entries: Array<{ path: string; type: "file" | "directory" | "nested_repo" | "submodule"; size_bytes?: number }> = [];
    const excludedSummary: Record<string, number> = {};

    const walk = async (repoPath: string, depth: number): Promise<void> => {
      if (depth > maxDepth) {
        return;
      }

      const resolved = await this.resolveForTree(repoPath, excludedSummary);
      if (!resolved) {
        return;
      }
      const boundary = await this.sandbox.classifyBoundary(repoPath);
      if (boundary.kind !== "normal" && repoPath !== ".") {
        entries.push({ path: boundary.path, type: boundary.kind });
        return;
      }
      if (resolved.stat.isDirectory()) {
        if (repoPath !== ".") {
          entries.push({ path: repoPath, type: "directory" });
        }
        const children = await readdir(resolved.absolutePath, { withFileTypes: true });
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          const childRepoPath = repoPath === "." ? child.name : `${repoPath}/${child.name}`;
          if (this.ignoreEngine.isSensitiveCandidate(childRepoPath)) {
            excludedSummary.secret_candidates = (excludedSummary.secret_candidates ?? 0) + 1;
            continue;
          }
          const isDependency = isDependencyPath(childRepoPath);
          const isGenerated = isGeneratedPath(childRepoPath);
          if (isDependency && !options.include_dependencies) {
            excludedSummary.dependencies = (excludedSummary.dependencies ?? 0) + 1;
            excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
            continue;
          }
          if (isGenerated && !options.include_generated) {
            excludedSummary.generated = (excludedSummary.generated ?? 0) + 1;
            excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
            continue;
          }
          const includedByFlag = (isDependency && options.include_dependencies) || (isGenerated && options.include_generated);
          if (respectDefaultExcludes && !includedByFlag && this.ignoreEngine.isIgnored(childRepoPath)) {
            excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
            continue;
          }
          await walk(childRepoPath, depth + 1);
        }
        return;
      }
      if (includeFiles && resolved.stat.isFile()) {
        entries.push({ path: repoPath, type: "file", size_bytes: Number(resolved.stat.size) });
      }
    };

    await walk(start, 0);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const pagedEntries = entries.slice(cursor, cursor + pageSize);
    const nextIndex = cursor + pagedEntries.length;
    const truncated = nextIndex < entries.length;
    return {
      entries: pagedEntries,
      excluded_summary: excludedSummary,
      truncated,
      next_cursor: truncated ? String(nextIndex) : undefined
    };
  }

  private async resolveForTree(
    repoPath: string,
    excludedSummary: Record<string, number>
  ): Promise<Awaited<ReturnType<PathSandbox["resolve"]>> | undefined> {
    try {
      return await this.sandbox.resolve(repoPath);
    } catch (error) {
      if (error instanceof RepoReaderError) {
        excludedSummary[error.code] = (excludedSummary[error.code] ?? 0) + 1;
        return undefined;
      }
      throw error;
    }
  }
}

function parseCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isGeneratedPath(repoPath: string): boolean {
  return /(^|\/)(dist|build|out|coverage)(\/|$)/.test(repoPath);
}

function isDependencyPath(repoPath: string): boolean {
  return /(^|\/)node_modules(\/|$)/.test(repoPath);
}
