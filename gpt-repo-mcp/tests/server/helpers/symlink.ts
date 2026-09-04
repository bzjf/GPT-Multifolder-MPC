import { symlink } from "node:fs/promises";

export async function createDirectoryLinkIfSupported(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (isSymlinkPermissionError(error)) return false;
    throw error;
  }
}

function isSymlinkPermissionError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && ((error as { code?: unknown }).code === "EPERM" || (error as { code?: unknown }).code === "EACCES")
  );
}
