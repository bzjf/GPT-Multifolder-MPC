import { posix } from "node:path";
import { validateRepoPath } from "./path-sandbox.js";

export type WriteBackupOptions = {
  backupDir: string;
  targetPath: string;
  oldSha256: string;
  now?: Date;
};

export function buildWriteBackupPath(options: WriteBackupOptions): string {
  const backupDir = validateRepoPath(options.backupDir);
  const targetPath = validateRepoPath(options.targetPath);
  const timestamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const oldShaPrefix = options.oldSha256.slice(0, 8);
  const filename = `${sanitizeTargetPath(targetPath)}__${timestamp}__${oldShaPrefix}.bak`;

  return validateRepoPath(posix.join(backupDir, filename));
}

function sanitizeTargetPath(targetPath: string): string {
  return targetPath
    .split("/")
    .filter(Boolean)
    .join("__")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}
