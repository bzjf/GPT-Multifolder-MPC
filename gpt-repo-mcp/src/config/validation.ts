import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { RepoReaderConfigSchema, type RepoReaderConfig } from "./schema.js";

export type ConfigIssue = {
  code: string;
  message: string;
};

export async function validateConfigDocument(document: unknown): Promise<{
  config?: RepoReaderConfig;
  issues: ConfigIssue[];
}> {
  const parsed = RepoReaderConfigSchema.safeParse(document);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        code: "SCHEMA_INVALID",
        message: `${formatPath(issue.path)}: ${issue.message}`
      }))
    };
  }

  const config = parsed.data;
  const issues: ConfigIssue[] = [];

  const seenIds = new Set<string>();
  for (const repo of config.repos) {
    if (seenIds.has(repo.repo_id)) {
      issues.push({
        code: "DUPLICATE_REPO_ID",
        message: `Duplicate repo_id "${repo.repo_id}".`
      });
      continue;
    }
    seenIds.add(repo.repo_id);
  }

  const seenRoots = new Map<string, string>();
  for (const repo of config.repos) {
    const rootPath = resolve(repo.root);
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(rootPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        issues.push({
          code: "ROOT_MISSING",
          message: `Root does not exist for repo_id "${repo.repo_id}": ${repo.root}`
        });
        continue;
      }
      throw error;
    }

    if (!stats.isDirectory()) {
      issues.push({
        code: "ROOT_NOT_DIRECTORY",
        message: `Root is not a directory for repo_id "${repo.repo_id}": ${repo.root}`
      });
      continue;
    }

    const canonicalRoot = await realpath(rootPath);
    const duplicateOwner = seenRoots.get(canonicalRoot);
    if (duplicateOwner) {
      issues.push({
        code: "DUPLICATE_ROOT",
        message: `Duplicate root detected for repo_id "${repo.repo_id}" and "${duplicateOwner}": ${canonicalRoot}`
      });
      continue;
    }
    seenRoots.set(canonicalRoot, repo.repo_id);

    if (!repo.allow_non_git && !await looksLikeGitRepository(canonicalRoot)) {
      issues.push({
        code: "NOT_GIT_REPO",
        message: `Root is not a git repository for repo_id "${repo.repo_id}": ${canonicalRoot}`
      });
    }

    const writeGlobs = [
      ...(repo.writes?.allowed_globs ?? []),
      ...(repo.writes?.denied_globs ?? [])
    ];
    for (const glob of writeGlobs) {
      if (glob.trim().length === 0) {
        issues.push({
          code: "WRITE_GLOB_INVALID",
          message: `Write policy contains an empty glob for repo_id "${repo.repo_id}".`
        });
      }
    }
  }

  return { config, issues };
}

async function looksLikeGitRepository(root: string): Promise<boolean> {
  try {
    await stat(join(root, ".git"));
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
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

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "config";
  }
  return `config.${path.map((segment) => String(segment)).join(".")}`;
}
