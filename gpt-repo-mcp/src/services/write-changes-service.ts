import type { WriteChange, WriteChangesInput, WriteChangesResult, WriteSimpleChange } from "../contracts/write.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { FileWriter } from "./file-writer.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { WritePolicy } from "./write-policy.js";

const MAX_CHANGES_PER_PACK = 25;
const MAX_TOTAL_CHANGE_CONTENT_BYTES = 5 * 1024 * 1024;
const NEXT_STEPS = [
  "Run repo_git_review to inspect the resulting diff.",
  "If the edit pack is wrong, use git recovery/restore workflow before committing.",
  "If the diff is good, use repo_write_stage and repo_write_commit."
];
const PARTIAL_FAILURE_RECOVERY_HINT =
  "Run repo_git_review, then use repo_git_restore_paths for tracked applied paths or repo_cleanup_paths for generated untracked artifacts.";

export class WriteChangesService {
  private readonly writer: FileWriter;

  constructor(root: string, sandbox: PathSandbox, policy: WritePolicy) {
    this.writer = new FileWriter(root, sandbox, policy);
  }

  async apply(input: Omit<WriteChangesInput, "repo_id">): Promise<WriteChangesResult> {
    if (input.changes.length > MAX_CHANGES_PER_PACK) {
      throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `Edit pack exceeds maximum changes: ${MAX_CHANGES_PER_PACK}`);
    }
    if (totalPayloadBytes(input.changes) > MAX_TOTAL_CHANGE_CONTENT_BYTES) {
      throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `Edit pack exceeds maximum total content bytes: ${MAX_TOTAL_CHANGE_CONTENT_BYTES}`);
    }
    assertUniqueTargetPaths(input.changes);

    const dryRun = input.dry_run ?? false;
    const appliedPaths: string[] = [];
    const files: WriteChangesResult["files"] = [];

    for (const change of input.changes) {
      try {
        const result = change.type === "edit"
          ? await this.writer.writeGroupedEdit({ path: change.path, edits: change.edits, dry_run: dryRun })
          : await this.writer.write(toWriteFileInput(change, dryRun));
        files.push({
          path: result.path,
          type: result.action,
          changed: result.changed,
          created: result.created,
          bytes_written: result.bytes_written,
          ...(result.old_sha256 ? { old_sha256: result.old_sha256 } : {}),
          ...(result.new_sha256 ? { new_sha256: result.new_sha256 } : {}),
          summary: result.summary
        });
        if (result.changed) {
          appliedPaths.push(result.path);
        }
      } catch (error) {
        throw addPartialFailureDiagnostics(error, appliedPaths, change.path);
      }
    }

    const changedPaths = unique(appliedPaths);
    const changed = files.filter((file) => file.changed).length;
    const created = files.filter((file) => file.created).length;
    const unchanged = files.length - changed;

    return {
      ok: true,
      dry_run: dryRun,
      changed_paths: changedPaths,
      files,
      counts: {
        requested: input.changes.length,
        changed,
        created,
        unchanged
      },
      summary: summarize(input.changes.length, changed, changedPaths.length, dryRun),
      warnings: [],
      next_steps: NEXT_STEPS
    };
  }
}

function toWriteFileInput(change: WriteSimpleChange, dryRun: boolean) {
  return {
    path: change.path,
    action: change.type,
    ...(typeof change.content === "string" ? { content: change.content } : {}),
    ...(typeof change.find === "string" ? { find: change.find } : {}),
    ...(typeof change.replace === "string" ? { replace: change.replace } : {}),
    create_dirs: change.type === "write" ? true : undefined,
    dry_run: dryRun
  };
}

function assertUniqueTargetPaths(changes: WriteChange[]): void {
  const seen = new Set<string>();
  for (const change of changes) {
    const normalized = safeDuplicatePathKey(change.path);
    if (seen.has(normalized)) {
      throw new RepoReaderError("VALIDATION_ERROR", `Edit pack contains multiple changes for the same path: ${normalized}`);
    }
    seen.add(normalized);
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function totalPayloadBytes(changes: WriteChange[]): number {
  return changes.reduce((total, change) => {
    if (change.type === "edit") {
      return total + change.edits.reduce((editTotal, edit) => {
        const contentBytes = typeof edit.content === "string" ? Buffer.byteLength(edit.content, "utf8") : 0;
        const replaceBytes = typeof edit.replace === "string" ? Buffer.byteLength(edit.replace, "utf8") : 0;
        return editTotal + contentBytes + replaceBytes;
      }, 0);
    }
    const contentBytes = typeof change.content === "string" ? Buffer.byteLength(change.content, "utf8") : 0;
    const replaceBytes = typeof change.replace === "string" ? Buffer.byteLength(change.replace, "utf8") : 0;
    return total + contentBytes + replaceBytes;
  }, 0);
}

function summarize(requested: number, changed: number, changedPathCount: number, dryRun: boolean): string {
  if (changed === 0) {
    return `No changes across ${requested} requested ${requested === 1 ? "file" : "changes"}.`;
  }
  const verb = dryRun ? "Dry run would apply" : "Applied";
  return `${verb} ${changed} ${changed === 1 ? "change" : "changes"} across ${changedPathCount} ${changedPathCount === 1 ? "file" : "files"}.`;
}

function addPartialFailureDiagnostics(error: unknown, appliedPaths: string[], failedPath: string): unknown {
  if (!(error instanceof RepoReaderError) || appliedPaths.length === 0) {
    return error;
  }
  return new RepoReaderError(error.code, error.message, {
    retryable: error.retryable,
    diagnostics: {
      ...error.diagnostics,
      applied_paths: unique(appliedPaths),
      ...(safeFailedPath(failedPath) ? { failed_path: safeFailedPath(failedPath) } : {}),
      recovery_hint: PARTIAL_FAILURE_RECOVERY_HINT
    }
  });
}

function safeFailedPath(path: string): string | undefined {
  try {
    return validateRepoPath(path);
  } catch {
    return undefined;
  }
}

function safeDuplicatePathKey(path: string): string {
  try {
    return validateRepoPath(path);
  } catch {
    return path;
  }
}
