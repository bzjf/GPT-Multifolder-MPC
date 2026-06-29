import ignore from "ignore";
import type { GitReviewInput, GitReviewResult } from "../contracts/git-review.contract.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { GitService } from "./git-service.js";
import { OperationsPolicy } from "./operations-policy.js";

type StatusFile = GitReviewResult["changed_paths"][number];

const STAGED_RECOVERY_WARNING = "STAGED_RECOVERY_REQUIRES_UNSTAGE_FIRST";
const STAGED_RECOVERY_GUIDANCE = [
  "Staged paths cannot be restored directly with repo_git_restore_paths because restore is worktree-only.",
  "For bad staged changes, use repo_write_recover with the review-provided unstage_paths and restore_paths, or use repo_write_unstage first when granular control is needed.",
  "If the staged diff is good, use repo_write_commit_dry_run before committing the exact staged paths."
];

export class GitReviewService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(
    private readonly root: string,
    private readonly operationsPolicy: OperationsPolicy = new OperationsPolicy()
  ) {}

  async review(input: GitReviewInput): Promise<GitReviewResult> {
    const git = new GitService(this.root);
    const [status, unstagedDiff, stagedDiff] = await Promise.all([
      git.status(),
      git.diff({}),
      git.diff({ staged: true })
    ]);
    const diff = mergeDiffs(stagedDiff, unstagedDiff);
    const changedPaths = status.files.map((file) => ({
      ...file,
      status: classifyStatus(file.index, file.worktree),
      staged: file.index !== " " && file.index !== "?",
      unstaged: file.worktree !== " " || file.index === "?"
    }));

    const maxFiles = input.max_files ?? diff.files.length;
    const diffSummaryTruncated = diff.truncated || diff.files.length > maxFiles;
    const warnings = [...diff.warnings];
    if (diffSummaryTruncated) {
      warnings.push("DIFF_SUMMARY_TRUNCATED");
    }
    if (status.clean) {
      warnings.push("NO_CHANGES");
    }

    const excludedPaths: Array<{ path: string; reason: string }> = [];
    const recommendedStagePaths: string[] = [];
    for (const path of changedPaths) {
      const exclusion = this.exclusionReason(path);
      if (exclusion) {
        excludedPaths.push({ path: path.path, reason: exclusion });
        continue;
      }
      if (path.unstaged && !path.staged) {
        recommendedStagePaths.push(path.path);
      }
    }
    if (excludedPaths.some((path) => path.reason === "UNTRACKED_REQUIRES_EXPLICIT_REVIEW")) {
      warnings.push("UNTRACKED_PATHS_EXCLUDED");
    }

    const stagedPaths = changedPaths
      .filter((path) => path.staged && !this.exclusionReason(path))
      .map((path) => path.path)
      .sort();
    const hasStagedExcludedPaths = changedPaths.some((path) => path.staged && this.exclusionReason(path));
    const stagedRecoveryPaths = changedPaths
      .filter((path) => path.staged && this.isRecoverableWorktreePath(path))
      .map((path) => path.path)
      .sort();
    if (stagedRecoveryPaths.length > 0) {
      warnings.push(STAGED_RECOVERY_WARNING);
    }
    const recoverableWorktreePaths = changedPaths
      .filter((path) => path.unstaged && !path.staged && this.isRecoverableWorktreePath(path))
      .map((path) => path.path)
      .sort();
    const cleanupPaths = changedPaths
      .filter((path) => path.status === "untracked" && this.isCleanupEligible(path.path))
      .map((path) => path.path)
      .sort();
    const stagePaths = [...new Set(recommendedStagePaths)].sort();
    const expectedCommitPaths = [...new Set([...stagedPaths, ...stagePaths])].sort();
    const recoverRestorePaths = [...new Set([...recoverableWorktreePaths, ...stagedRecoveryPaths])].sort();
    const suggestedCommitMessage = suggestCommitMessage(expectedCommitPaths);
    const nextToolPayloads: GitReviewResult["next_tool_payloads"] = {};

    if (recoverableWorktreePaths.length > 0) {
      nextToolPayloads.repo_git_restore_paths_dry_run = {
        repo_id: input.repo_id,
        paths: recoverableWorktreePaths,
        expected_head_sha: status.head_sha,
        dry_run: true
      };
      nextToolPayloads.repo_git_restore_paths_actual = {
        repo_id: input.repo_id,
        paths: recoverableWorktreePaths,
        expected_head_sha: status.head_sha,
        dry_run: false
      };
    }

    if (cleanupPaths.length > 0) {
      nextToolPayloads.repo_cleanup_paths_dry_run = {
        repo_id: input.repo_id,
        paths: cleanupPaths,
        dry_run: true
      };
      nextToolPayloads.repo_cleanup_paths_actual = {
        repo_id: input.repo_id,
        paths: cleanupPaths,
        dry_run: false
      };
    }

    if (stagedPaths.length > 0) {
      nextToolPayloads.repo_write_unstage_dry_run = {
        repo_id: input.repo_id,
        paths: stagedPaths,
        expected_head_sha: status.head_sha,
        dry_run: true
      };
      nextToolPayloads.repo_write_unstage_actual = {
        repo_id: input.repo_id,
        paths: stagedPaths,
        expected_head_sha: status.head_sha,
        dry_run: false
      };
    }

    if (stagedRecoveryPaths.length > 0 || recoverRestorePaths.length > 0 || cleanupPaths.length > 0) {
      nextToolPayloads.repo_write_recover_dry_run = {
        repo_id: input.repo_id,
        expected_head_sha: status.head_sha,
        ...(stagedRecoveryPaths.length > 0 ? { unstage_paths: stagedRecoveryPaths } : {}),
        ...(recoverRestorePaths.length > 0 ? { restore_paths: recoverRestorePaths } : {}),
        ...(cleanupPaths.length > 0 ? { cleanup_paths: cleanupPaths } : {}),
        dry_run: true
      };
      nextToolPayloads.repo_write_recover_actual = {
        repo_id: input.repo_id,
        expected_head_sha: status.head_sha,
        ...(stagedRecoveryPaths.length > 0 ? { unstage_paths: stagedRecoveryPaths } : {}),
        ...(recoverRestorePaths.length > 0 ? { restore_paths: recoverRestorePaths } : {}),
        ...(cleanupPaths.length > 0 ? { cleanup_paths: cleanupPaths } : {}),
        dry_run: false
      };
    }

    if (stagePaths.length > 0) {
      nextToolPayloads.repo_write_stage_dry_run = {
        repo_id: input.repo_id,
        paths: stagePaths,
        expected_head_sha: status.head_sha,
        dry_run: true
      };
      nextToolPayloads.repo_write_stage_actual = {
        repo_id: input.repo_id,
        paths: stagePaths,
        expected_head_sha: status.head_sha,
        dry_run: false
      };
      if (stagedPaths.length === 0 && !hasStagedExcludedPaths) {
        nextToolPayloads.repo_write_stage_commit_dry_run = {
          repo_id: input.repo_id,
          paths: stagePaths,
          message: suggestedCommitMessage,
          expected_head_sha: status.head_sha,
          dry_run: true
        };
        nextToolPayloads.repo_write_stage_commit_actual = {
          repo_id: input.repo_id,
          paths: stagePaths,
          message: suggestedCommitMessage,
          expected_head_sha: status.head_sha,
          dry_run: false
        };
      }
    }

    if (expectedCommitPaths.length > 0) {
      nextToolPayloads.repo_write_commit_dry_run = {
        repo_id: input.repo_id,
        message: suggestedCommitMessage,
        expected_head_sha: status.head_sha,
        expected_staged_paths: expectedCommitPaths,
        dry_run: true
      };
    }

    return {
      ok: true,
      branch: status.branch,
      head_sha: status.head_sha,
      clean: status.clean,
      changed_paths: changedPaths,
      diff_summary: {
        file_count: diff.files.length,
        truncated: diffSummaryTruncated,
        files: diff.files.slice(0, maxFiles).map((file) => ({
          path: file.path,
          status: file.status,
          hunk_count: file.hunks.length,
          summary: summarizeDiffFile(file.path, file.status, file.hunks.length)
        }))
      },
      recommendation: {
        ready_to_stage: stagePaths.length > 0,
        recommended_stage_paths: stagePaths,
        excluded_paths: excludedPaths,
        suggested_commit_message: suggestedCommitMessage,
        risk_level: riskLevel(warnings, excludedPaths),
        warnings,
        ...(stagedRecoveryPaths.length > 0 ? { recovery_guidance: STAGED_RECOVERY_GUIDANCE } : {})
      },
      next_tool_payloads: status.clean ? {} : nextToolPayloads
    };
  }

  private exclusionReason(path: StatusFile): string | undefined {
    if (isLocalCodexArtifactPath(path.path)) {
      return "LOCAL_CODEX_ARTIFACT_EXCLUDED";
    }
    if (this.ignoreEngine.isSensitiveCandidate(path.path)) {
      return "SECRET_CANDIDATE_REQUIRES_MANUAL_REVIEW";
    }
    if (isGeneratedPath(path.path)) {
      return "GENERATED_PATH_EXCLUDED";
    }
    if (path.status === "untracked") {
      return "UNTRACKED_REQUIRES_EXPLICIT_REVIEW";
    }
    if (path.status === "deleted") {
      return "DELETED_PATH_REQUIRES_EXPLICIT_REVIEW";
    }
    if (path.status === "renamed") {
      return "RENAMED_PATH_REQUIRES_EXPLICIT_REVIEW";
    }
    return undefined;
  }

  private isCleanupEligible(path: string): boolean {
    if (!this.operationsPolicy.config.enabled || !this.operationsPolicy.config.cleanup_enabled) {
      return false;
    }
    if (this.ignoreEngine.isSensitiveCandidate(path)) {
      return false;
    }
    const matcher = ignore().add(this.operationsPolicy.config.cleanup_allowed_globs);
    return matcher.ignores(path) || matcher.ignores(`${path}/placeholder`);
  }

  private isRecoverableWorktreePath(path: StatusFile): boolean {
    if (path.status === "untracked" || path.status === "renamed") {
      return false;
    }
    return !this.ignoreEngine.isSensitiveCandidate(path.path);
  }
}

function classifyStatus(index: string, worktree: string): StatusFile["status"] {
  if (index === "?" && worktree === "?") {
    return "untracked";
  }
  if (index === "R" || worktree === "R") {
    return "renamed";
  }
  if (index === "D" || worktree === "D") {
    return "deleted";
  }
  if (index === "A" || worktree === "A") {
    return "added";
  }
  if (index === "M" || worktree === "M") {
    return "modified";
  }
  return "unknown";
}

function isGeneratedPath(path: string): boolean {
  return /^(dist|coverage|test-results|node_modules)\//.test(path);
}

function isLocalCodexArtifactPath(path: string): boolean {
  return path.startsWith(".chatgpt/codex-runs/");
}

type GitDiff = Awaited<ReturnType<GitService["diff"]>>;

function mergeDiffs(stagedDiff: GitDiff, unstagedDiff: GitDiff): GitDiff {
  const filesByPath = new Map<string, GitDiff["files"][number]>();
  for (const file of [...stagedDiff.files, ...unstagedDiff.files]) {
    const existing = filesByPath.get(file.path);
    if (!existing) {
      filesByPath.set(file.path, { ...file, hunks: [...file.hunks] });
      continue;
    }
    filesByPath.set(file.path, {
      ...existing,
      status: existing.status ?? file.status,
      original_path: existing.original_path ?? file.original_path,
      hunks: [...existing.hunks, ...file.hunks]
    });
  }

  return {
    base: stagedDiff.base ?? unstagedDiff.base,
    compare: stagedDiff.compare ?? unstagedDiff.compare,
    staged: stagedDiff.staged,
    unstaged: unstagedDiff.unstaged,
    files: [...filesByPath.values()],
    truncated: stagedDiff.truncated || unstagedDiff.truncated,
    warnings: [...stagedDiff.warnings, ...unstagedDiff.warnings]
  };
}

function summarizeDiffFile(path: string, status: string | undefined, hunkCount: number): string {
  return `${status ?? "modified"} ${path} (${hunkCount} hunks)`;
}

function suggestCommitMessage(paths: string[]): string {
  if (paths.length === 0) {
    return "No changes to commit";
  }
  if (paths.every((path) => path.startsWith("docs/") || path.startsWith(".chatgpt/"))) {
    return "Update docs";
  }
  if (paths.some((path) => path.startsWith("src/tools/"))) {
    return "Update tool surface";
  }
  if (paths.some((path) => path.startsWith("src/services/") || path.startsWith("src/contracts/"))) {
    return "Update write tooling";
  }
  if (paths.some((path) => path.startsWith("tests/"))) {
    return "Update tests";
  }
  return "Update reviewed files";
}

function riskLevel(warnings: string[], excludedPaths: Array<{ path: string; reason: string }>): "low" | "medium" | "high" {
  if (excludedPaths.some((path) => path.reason.includes("SECRET"))) {
    return "high";
  }
  if (warnings.length === 1 && warnings[0] === "NO_CHANGES") {
    return "low";
  }
  if (warnings.length > 0 || excludedPaths.length > 0) {
    return "medium";
  }
  return "low";
}
