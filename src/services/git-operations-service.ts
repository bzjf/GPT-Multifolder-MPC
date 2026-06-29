import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  GitCommitResult,
  GitRecoverResult,
  GitRestorePathsResult,
  GitStageCommitResult,
  GitStageResult,
  GitUnstageResult
} from "../contracts/git-operations.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { CleanupService } from "./cleanup-service.js";
import { validateRepoPath } from "./path-sandbox.js";
import { OperationsPolicy } from "./operations-policy.js";
import { SecretScanner } from "./secret-scanner.js";

const execFileAsync = promisify(execFile);
const ALLOWED_ENV_TEMPLATE_PATHS = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  "example.env"
]);

type StageInput = {
  paths: string[];
  expected_head_sha: string;
  dry_run?: boolean;
};

type RestorePathsInput = StageInput;

type CommitInput = {
  message: string;
  expected_head_sha: string;
  expected_staged_paths: string[];
  dry_run?: boolean;
};

type StageCommitInput = {
  paths: string[];
  message: string;
  expected_head_sha: string;
  dry_run?: boolean;
};

type RecoverInput = {
  expected_head_sha: string;
  unstage_paths?: string[];
  restore_paths?: string[];
  cleanup_paths?: string[];
  dry_run?: boolean;
};

export class GitOperationsService {
  private readonly secretScanner = new SecretScanner();

  constructor(private readonly root: string, private readonly policy: OperationsPolicy) {}

  async stage(input: StageInput): Promise<GitStageResult> {
    this.policy.assertStageAllowed(input.paths);
    const headSha = await this.assertExpectedHead(input.expected_head_sha);
    const paths = await this.validateExplicitPaths(input.paths);

    if (!input.dry_run) {
      await this.git(["add", "--", ...paths]);
    }
    return {
      ok: true,
      dry_run: input.dry_run ?? false,
      head_sha: headSha,
      staged_paths: paths,
      skipped: [],
      warnings: []
    };
  }

  async unstage(input: StageInput): Promise<GitUnstageResult> {
    this.policy.assertStageAllowed(input.paths);
    const headSha = await this.assertExpectedHead(input.expected_head_sha);
    const paths = await this.validateExplicitPaths(input.paths);

    if (!input.dry_run) {
      await this.git(["restore", "--staged", "--", ...paths]);
    }
    return {
      ok: true,
      dry_run: input.dry_run ?? false,
      head_sha: headSha,
      unstaged_paths: paths,
      skipped: [],
      warnings: []
    };
  }

  async restorePaths(input: RestorePathsInput): Promise<GitRestorePathsResult> {
    this.policy.assertRestoreAllowed(input.paths);
    const headSha = await this.assertExpectedHead(input.expected_head_sha);
    const paths = await this.validateExplicitPaths(input.paths, { scanEnvTemplateContent: false });

    if (!input.dry_run) {
      await this.git(["restore", "--", ...paths]);
    }
    return {
      ok: true,
      dry_run: input.dry_run ?? false,
      head_sha: headSha,
      restored_paths: paths,
      skipped: [],
      warnings: []
    };
  }

  async commit(input: CommitInput): Promise<GitCommitResult> {
    this.policy.assertCommitAllowed(input.expected_staged_paths);
    const headBefore = await this.assertExpectedHead(input.expected_head_sha);
    this.validateCommitMessage(input.message);
    const expectedPaths = await this.validateExplicitPaths(input.expected_staged_paths);
    const actualPaths = await this.stagedPaths();
    if (actualPaths.length === 0) {
      throw new RepoReaderError("GIT_NOTHING_STAGED", "No staged changes are available to commit.");
    }
    await this.validateExplicitPaths(actualPaths);
    if (!samePathSet(actualPaths, expectedPaths)) {
      throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Actual staged paths do not match expected_staged_paths.", {
        diagnostics: { actual_paths: actualPaths, expected_paths: expectedPaths }
      });
    }

    if (input.dry_run) {
      return {
        ok: true,
        dry_run: true,
        head_before: headBefore,
        committed_paths: actualPaths,
        warnings: []
      };
    }

    await this.git(["commit", "-m", input.message]);
    const headAfter = await this.headSha();
    return {
      ok: true,
      dry_run: false,
      head_before: headBefore,
      head_after: headAfter,
      commit_sha: headAfter,
      committed_paths: actualPaths,
      warnings: []
    };
  }

  async stageCommit(input: StageCommitInput): Promise<GitStageCommitResult> {
    this.policy.assertStageAllowed(input.paths);
    this.policy.assertCommitAllowed(input.paths);
    const headBefore = await this.assertExpectedHead(input.expected_head_sha);
    this.validateCommitMessage(input.message);
    const paths = await this.validateExplicitPaths(input.paths);
    const preStagedPaths = await this.stagedPaths();
    if (preStagedPaths.length > 0 && !samePathSet(preStagedPaths, paths)) {
      throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Actual staged paths do not match requested stage-and-commit paths.", {
        diagnostics: { actual_paths: preStagedPaths, expected_paths: paths }
      });
    }

    if (input.dry_run) {
      return {
        ok: true,
        dry_run: true,
        head_before: headBefore,
        staged_paths: paths,
        committed_paths: paths,
        warnings: []
      };
    }

    await this.git(["add", "--", ...paths]);
    const actualPaths = await this.stagedPaths();
    await this.validateExplicitPaths(actualPaths);
    if (actualPaths.length === 0) {
      throw new RepoReaderError("GIT_NOTHING_STAGED", "No staged changes are available to commit.");
    }
    if (!samePathSet(actualPaths, paths)) {
      throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Actual staged paths do not match requested stage-and-commit paths.", {
        diagnostics: { actual_paths: actualPaths, expected_paths: paths }
      });
    }

    await this.git(["commit", "-m", input.message]);
    const headAfter = await this.headSha();
    const status = await this.statusSummary();
    return {
      ok: true,
      dry_run: false,
      head_before: headBefore,
      head_after: headAfter,
      commit_sha: headAfter,
      staged_paths: paths,
      committed_paths: actualPaths,
      remaining_changes: status.remaining_changes,
      clean_after: status.clean_after,
      warnings: []
    };
  }

  async recover(input: RecoverInput): Promise<GitRecoverResult> {
    const unstagePathsInput = input.unstage_paths ?? [];
    const restorePathsInput = input.restore_paths ?? [];
    const cleanupPathsInput = input.cleanup_paths ?? [];
    if (unstagePathsInput.length === 0 && restorePathsInput.length === 0 && cleanupPathsInput.length === 0) {
      throw new RepoReaderError("GIT_OPERATION_PATHS_REQUIRED", "At least one explicit recovery path is required.");
    }

    const headSha = await this.assertExpectedHead(input.expected_head_sha);
    if (unstagePathsInput.length > 0) {
      this.policy.assertStageAllowed(unstagePathsInput);
    }
    if (restorePathsInput.length > 0) {
      this.policy.assertRestoreAllowed(restorePathsInput);
    }

    const unstagePaths = unstagePathsInput.length > 0 ? await this.validateExplicitPaths(unstagePathsInput) : [];
    const restorePaths = restorePathsInput.length > 0 ? await this.validateExplicitPaths(restorePathsInput, { scanEnvTemplateContent: false }) : [];
    const cleanupService = new CleanupService(this.root, this.policy);
    const cleanupPreview = cleanupPathsInput.length > 0
      ? await cleanupService.cleanup({ paths: cleanupPathsInput, dry_run: true })
      : { deleted: [], skipped: [], warnings: [] };

    if (!input.dry_run) {
      if (unstagePaths.length > 0) {
        await this.git(["restore", "--staged", "--", ...unstagePaths]);
      }
      if (restorePaths.length > 0) {
        await this.git(["restore", "--", ...restorePaths]);
      }
      if (cleanupPathsInput.length > 0) {
        await cleanupService.cleanup({ paths: cleanupPathsInput });
      }
    }

    const status = await this.statusSummary();
    return {
      ok: true,
      dry_run: input.dry_run ?? false,
      head_sha: headSha,
      unstaged_paths: unstagePaths,
      restored_paths: restorePaths,
      deleted: cleanupPreview.deleted,
      skipped: cleanupPreview.skipped,
      remaining_changes: status.remaining_changes,
      clean_after: status.clean_after,
      warnings: cleanupPreview.warnings
    };
  }

  private async assertExpectedHead(expectedHeadSha: string): Promise<string> {
    const headSha = await this.headSha();
    if (headSha !== expectedHeadSha) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Current HEAD does not match expected_head_sha.", {
        diagnostics: { head_sha: headSha, expected_head_sha: expectedHeadSha }
      });
    }
    return headSha;
  }

  private async headSha(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  private async stagedPaths(): Promise<string[]> {
    return (await this.git(["diff", "--name-only", "--cached"]))
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  private async statusSummary(): Promise<{ remaining_changes: number; clean_after: boolean }> {
    const output = await this.git(["status", "--porcelain=v1", "--untracked-files=all"]);
    const remainingChanges = output.split("\n").filter(Boolean).length;
    return {
      remaining_changes: remainingChanges,
      clean_after: remainingChanges === 0
    };
  }

  private async validateExplicitPaths(paths: string[], options: { scanEnvTemplateContent?: boolean } = {}): Promise<string[]> {
    const normalized = paths.map((path) => this.validateExplicitPath(path));
    for (const path of normalized) {
      await this.assertWithinRoot(path);
      if (options.scanEnvTemplateContent ?? true) {
        await this.assertSafeEnvTemplateContent(path);
      }
    }
    return normalized;
  }

  private validateExplicitPath(path: string): string {
    const normalized = validateRepoPath(path);
    if (normalized === "." || normalized === "*" || /[*?[\]{}]/.test(normalized) || /(?:^|\/)\.\.(?:\/|$)/.test(normalized)) {
      throw new RepoReaderError("GIT_OPERATION_UNSAFE_PATHSPEC", `Unsafe git pathspec rejected: ${path}`);
    }
    if (/[\0\r\n;&|`$<>]/.test(normalized) || normalized.startsWith(":") || normalized.startsWith("-")) {
      throw new RepoReaderError("GIT_OPERATION_UNSAFE_PATHSPEC", `Unsafe git pathspec rejected: ${path}`);
    }
    if (normalized === ".git" || normalized.startsWith(".git/")) {
      throw new RepoReaderError("GIT_OPERATION_UNSAFE_PATHSPEC", `Git internals cannot be staged: ${path}`);
    }
    if (isHardSecretPath(normalized) && !isAllowedEnvTemplatePath(normalized)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret candidate blocked: ${normalized}`);
    }
    return normalized;
  }

  private async assertSafeEnvTemplateContent(repoPath: string): Promise<void> {
    if (!isAllowedEnvTemplatePath(repoPath)) {
      return;
    }

    const content = await readFile(join(this.root, repoPath), "utf8");
    if (this.secretScanner.hasSecretValue(content)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret content blocked: ${repoPath}`);
    }
  }

  private validateCommitMessage(message: string): void {
    const trimmed = message.trim();
    if (trimmed.length === 0 || /[\0\r\n]/.test(message) || /(?:&&|\|\||;|`|\$\(|<|>)/.test(message)) {
      throw new RepoReaderError("GIT_COMMIT_MESSAGE_INVALID", "Commit message is empty or contains command-like syntax.");
    }
  }

  private async assertWithinRoot(repoPath: string): Promise<void> {
    const absolutePath = join(this.root, repoPath);
    try {
      const stat = await lstat(absolutePath);
      if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${repoPath}`);
      }
      await assertRealPathWithinRoot(this.root, absolutePath);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    await assertExistingParentWithinRoot(this.root, repoPath);
  }

  private async git(args: string[]): Promise<string> {
    try {
      const result = await execFileAsync("git", args, {
        cwd: this.root,
        maxBuffer: 1024 * 1024,
        env: gitEnv()
      });
      return result.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git operation failed";
      throw new RepoReaderError("GIT_ERROR", message);
    }
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {})
  };
}

async function assertExistingParentWithinRoot(root: string, repoPath: string): Promise<void> {
  let parent = dirname(repoPath);
  while (parent !== ".") {
    const absoluteParent = join(root, parent);
    try {
      await assertRealPathWithinRoot(root, absoluteParent);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      parent = dirname(parent);
    }
  }
  await assertRealPathWithinRoot(root, root);
}

async function assertRealPathWithinRoot(root: string, target: string): Promise<void> {
  const [rootReal, targetReal] = await Promise.all([
    realpath(root),
    realpath(target)
  ]);
  const rel = relative(resolve(rootReal), resolve(targetReal));
  if (rel !== "" && (rel.startsWith("..") || rel.includes(`..${sep}`))) {
    throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", `Path escapes approved repository: ${target}`);
  }
}

function samePathSet(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function isAllowedEnvTemplatePath(repoPath: string): boolean {
  return ALLOWED_ENV_TEMPLATE_PATHS.has(repoPath);
}

function isHardSecretPath(repoPath: string): boolean {
  const lower = repoPath.toLowerCase();
  const base = lower.split("/").at(-1) ?? lower;
  const segments = lower.split("/");
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    segments.includes("secrets") ||
    segments.includes("credentials")
  );
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
  );
}
