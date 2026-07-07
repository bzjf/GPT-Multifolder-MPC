import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WriteChange, WriteChangesInput, WriteChangesResult, WriteSimpleChange } from "../contracts/write.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { FileWriter, type PreparedWriteOperation } from "./file-writer.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { WritePolicy } from "./write-policy.js";

const MAX_CHANGES_PER_PACK = 25;
const MAX_TOTAL_CHANGE_CONTENT_BYTES = 5 * 1024 * 1024;
const PREPARE_CONCURRENCY = 4;
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
    assertNonConflictingTargetPaths(input.changes);

    const dryRun = input.dry_run ?? false;
    // Phase 1: read, validate, scan, and compute every target without mutating the repository.
    // Bounded concurrency overlaps independent file I/O while preserving result order.
    const prepared = await prepareWithConcurrency(
      input.changes,
      PREPARE_CONCURRENCY,
      async (change) => change.type === "edit"
        ? this.writer.prepareGroupedEdit({ path: change.path, edits: change.edits, dry_run: dryRun })
        : this.writer.prepareWrite(toWriteFileInput(change, dryRun))
    );
    assertPreparedTargetsDoNotConflict(prepared);

    const appliedPaths: string[] = [];
    const files: WriteChangesResult["files"] = [];

    // Phase 2: only after every preparation succeeds, commit writes in request order.
    for (let index = 0; index < prepared.length; index += 1) {
      const operation = prepared[index];
      const change = input.changes[index];
      if (!operation || !change) continue;
      try {
        const result = dryRun
          ? operation.result
          : await this.writer.commitPrepared(operation);
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

async function prepareWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  prepare: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = await prepare(item, index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    const firstFailure = failures[0];
    if (firstFailure) throw firstFailure.error;
  }
  return results;
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

function assertNonConflictingTargetPaths(changes: WriteChange[]): void {
  const seen: Array<{ path: string; key: string }> = [];
  for (const change of changes) {
    const path = normalizeTargetPath(change.path);
    const key = pathComparisonKey(path);
    const conflict = seen.find((candidate) => repoPathsConflict(candidate.key, key));
    if (conflict) {
      throw new RepoReaderError(
        "VALIDATION_ERROR",
        `Edit pack contains conflicting target paths: ${conflict.path} and ${path}`
      );
    }
    seen.push({ path, key });
  }
}

function assertPreparedTargetsDoNotConflict(prepared: PreparedWriteOperation[]): void {
  const seen: PreparedWriteOperation[] = [];
  for (const operation of prepared) {
    const conflict = seen.find((candidate) =>
      absolutePathsConflict(candidate.absolutePath, operation.absolutePath)
    );
    if (conflict) {
      throw new RepoReaderError(
        "VALIDATION_ERROR",
        `Edit pack resolves to conflicting targets: ${conflict.result.path} and ${operation.result.path}`
      );
    }
    seen.push(operation);
  }
}

function normalizeTargetPath(path: string): string {
  const normalized = validateRepoPath(path).replace(/\/+$/, "");
  return normalized || ".";
}

function pathComparisonKey(path: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? path.toLowerCase()
    : path;
}

function repoPathsConflict(left: string, right: string): boolean {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  return isSegmentPrefix(leftParts, rightParts) || isSegmentPrefix(rightParts, leftParts);
}

function isSegmentPrefix(prefix: string[], candidate: string[]): boolean {
  return prefix.length <= candidate.length
    && prefix.every((segment, index) => candidate[index] === segment);
}

function absolutePathsConflict(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return isWithinAbsolutePath(resolvedLeft, resolvedRight)
    || isWithinAbsolutePath(resolvedRight, resolvedLeft);
}

function isWithinAbsolutePath(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  if (rel === "") return true;
  const firstSegment = rel.split(sep)[0];
  return firstSegment !== ".." && !isAbsolute(rel);
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

