import { DEFAULT_OPERATIONS_POLICY } from "../policies/operations-defaults.js";
import { RepoReaderError } from "../runtime/errors.js";

export type OperationsPolicyConfig = {
  enabled?: boolean;
  git_stage_enabled?: boolean;
  git_commit_enabled?: boolean;
  max_paths_per_operation?: number;
  cleanup_enabled?: boolean;
  cleanup_allowed_globs?: string[];
};

export type EffectiveOperationsPolicy = {
  enabled: boolean;
  git_stage_enabled: boolean;
  git_commit_enabled: boolean;
  max_paths_per_operation: number;
  cleanup_enabled: boolean;
  cleanup_allowed_globs: string[];
};

export class OperationsPolicy {
  readonly config: EffectiveOperationsPolicy;

  constructor(config: OperationsPolicyConfig = {}) {
    this.config = {
      enabled: config.enabled ?? DEFAULT_OPERATIONS_POLICY.enabled,
      git_stage_enabled: config.git_stage_enabled ?? DEFAULT_OPERATIONS_POLICY.git_stage_enabled,
      git_commit_enabled: config.git_commit_enabled ?? DEFAULT_OPERATIONS_POLICY.git_commit_enabled,
      max_paths_per_operation: config.max_paths_per_operation ?? DEFAULT_OPERATIONS_POLICY.max_paths_per_operation,
      cleanup_enabled: config.cleanup_enabled ?? DEFAULT_OPERATIONS_POLICY.cleanup_enabled,
      cleanup_allowed_globs: config.cleanup_allowed_globs ?? [...DEFAULT_OPERATIONS_POLICY.cleanup_allowed_globs]
    };
  }

  assertStageAllowed(paths: string[]): void {
    this.assertEnabled();
    if (!this.config.git_stage_enabled) {
      throw new RepoReaderError("GIT_STAGE_DISABLED", "Git staging operations are disabled for this repository.");
    }
    this.assertPathCount(paths);
  }

  assertCommitAllowed(paths: string[]): void {
    this.assertEnabled();
    if (!this.config.git_commit_enabled) {
      throw new RepoReaderError("GIT_COMMIT_DISABLED", "Git commit operations are disabled for this repository.");
    }
    this.assertPathCount(paths);
  }

  assertRestoreAllowed(paths: string[]): void {
    this.assertEnabled();
    this.assertPathCount(paths);
  }

  assertCleanupAllowed(paths: string[]): void {
    this.assertEnabled();
    if (!this.config.cleanup_enabled) {
      throw new RepoReaderError("CLEANUP_DISABLED", "Cleanup operations are disabled for this repository.");
    }
    if (paths.length === 0) {
      throw new RepoReaderError("CLEANUP_PATHS_REQUIRED", "At least one explicit cleanup path is required.");
    }
    this.assertPathCount(paths);
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new RepoReaderError("OPERATIONS_DISABLED", "Repository operations are disabled for this repository.");
    }
  }

  private assertPathCount(paths: string[]): void {
    if (paths.length === 0) {
      throw new RepoReaderError("GIT_OPERATION_PATHS_REQUIRED", "At least one explicit path is required.");
    }
    if (paths.length > this.config.max_paths_per_operation) {
      throw new RepoReaderError("GIT_OPERATION_TOO_MANY_PATHS", `Too many paths for one operation: ${paths.length}`);
    }
  }
}
