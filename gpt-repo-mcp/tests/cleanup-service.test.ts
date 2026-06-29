import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { CleanupService } from "../src/services/cleanup-service.js";
import { OperationsPolicy, type OperationsPolicyConfig } from "../src/services/operations-policy.js";

const execFileAsync = promisify(execFile);

describe("CleanupService", () => {
  test("dry_run cleanup reports allowed file and does not delete it", async () => {
    const fixture = await createCleanupFixture();
    const service = createService(fixture.root);

    const result = await service.cleanup({
      paths: [".chatgpt/tool-tests/result.txt"],
      dry_run: true
    });

    expect(result).toEqual({
      ok: true,
      dry_run: true,
      deleted: [{ path: ".chatgpt/tool-tests/result.txt", type: "file" }],
      skipped: [],
      warnings: []
    });
    await expect(readFile(join(fixture.root, ".chatgpt", "tool-tests", "result.txt"), "utf8")).resolves.toBe("temporary\n");
  });

  test("cleanup deletes allowed .chatgpt/tool-tests file", async () => {
    const fixture = await createCleanupFixture();
    const service = createService(fixture.root);

    const result = await service.cleanup({
      paths: [".chatgpt/tool-tests/result.txt"]
    });

    expect(result.deleted).toEqual([{ path: ".chatgpt/tool-tests/result.txt", type: "file" }]);
    await expect(access(join(fixture.root, ".chatgpt", "tool-tests", "result.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("cleanup deletes allowed .chatgpt/tool-tests directory recursively", async () => {
    const fixture = await createCleanupFixture();
    const service = createService(fixture.root);

    const result = await service.cleanup({
      paths: [".chatgpt/tool-tests"]
    });

    expect(result.deleted).toEqual([{ path: ".chatgpt/tool-tests", type: "directory" }]);
    await expect(access(join(fixture.root, ".chatgpt", "tool-tests"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("cleanup deletes allowed .chatgpt/backups file", async () => {
    const fixture = await createCleanupFixture();
    const service = createService(fixture.root);

    const result = await service.cleanup({
      paths: [".chatgpt/backups/repo_write_file/old.bak"]
    });

    expect(result.deleted).toEqual([{ path: ".chatgpt/backups/repo_write_file/old.bak", type: "file" }]);
    await expect(access(join(fixture.root, ".chatgpt", "backups", "repo_write_file", "old.bak"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("cleanup deletes explicit untracked .chatgpt/audits artifact", async () => {
    const fixture = await createGitCleanupFixture();
    const service = createService(fixture.root);

    const result = await service.cleanup({
      paths: [".chatgpt/audits/2026-06-02-write-handoff-runtime-smoke.md"]
    });

    expect(result.deleted).toEqual([
      { path: ".chatgpt/audits/2026-06-02-write-handoff-runtime-smoke.md", type: "file" }
    ]);
    await expect(access(join(fixture.root, ".chatgpt", "audits", "2026-06-02-write-handoff-runtime-smoke.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("cleanup deletes explicit untracked Codex run artifact", async () => {
    const fixture = await createCleanupFixture();
    const service = createService(fixture.root);

    const result = await service.cleanup({
      paths: [".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md"]
    });

    expect(result.deleted).toEqual([
      { path: ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md", type: "file" }
    ]);
    await expect(access(join(
      fixture.root,
      ".chatgpt",
      "codex-runs",
      "2026-06-04T081500Z-fix-login-expiry",
      "RESULT.md"
    ))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("cleanup refuses tracked files even when they match cleanup globs", async () => {
    const fixture = await createGitCleanupFixture();
    const service = createService(fixture.root);

    await expect(service.cleanup({
      paths: [".chatgpt/audits/tracked.md"]
    })).rejects.toMatchObject({ code: "CLEANUP_TRACKED_PATH" });
    await expect(readFile(join(fixture.root, ".chatgpt", "audits", "tracked.md"), "utf8")).resolves.toBe("tracked\n");
  });

  test("cleanup rejects unsafe paths", async () => {
    const fixture = await createCleanupFixture();
    const service = createService(fixture.root);

    await expect(service.cleanup({ paths: [".env"] })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
    await expect(service.cleanup({ paths: [".git/config"] })).rejects.toMatchObject({ code: "CLEANUP_UNSAFE_PATH" });
    await expect(service.cleanup({ paths: ["../outside.txt"] })).rejects.toMatchObject({ code: "PATH_TRAVERSAL_REJECTED" });
    await expect(service.cleanup({ paths: [join(fixture.root, ".chatgpt", "tool-tests", "result.txt")] })).rejects.toMatchObject({ code: "ABSOLUTE_PATH_REJECTED" });
    await expect(service.cleanup({ paths: ["."] })).rejects.toMatchObject({ code: "CLEANUP_UNSAFE_PATH" });
    await expect(service.cleanup({ paths: ["*"] })).rejects.toMatchObject({ code: "CLEANUP_UNSAFE_PATH" });
  });

  test("cleanup rejects path outside cleanup_allowed_globs", async () => {
    const fixture = await createCleanupFixture();
    const service = createService(fixture.root);

    await expect(service.cleanup({ paths: ["docs/notes.md"] })).rejects.toMatchObject({
      code: "CLEANUP_NOT_ALLOWED_GLOB"
    });
  });

  test("cleanup rejects symlink escape", async () => {
    const fixture = await createCleanupFixture({ includeSymlink: true });
    const service = createService(fixture.root);

    await expect(service.cleanup({ paths: [".chatgpt/tool-tests/outside-link.txt"] })).rejects.toMatchObject({
      code: "SYMLINK_ESCAPE_REJECTED"
    });
  });

  test("cleanup disabled by default", async () => {
    const fixture = await createCleanupFixture();
    const service = new CleanupService(fixture.root, new OperationsPolicy());

    await expect(service.cleanup({ paths: [".chatgpt/tool-tests/result.txt"] })).rejects.toMatchObject({
      code: "OPERATIONS_DISABLED"
    });
  });

  test("cleanup requires operations.enabled and operations.cleanup_enabled", async () => {
    const fixture = await createCleanupFixture();
    const disabledOperations = createService(fixture.root, { enabled: false, cleanup_enabled: true });
    const disabledCleanup = createService(fixture.root, { enabled: true, cleanup_enabled: false });

    await expect(disabledOperations.cleanup({ paths: [".chatgpt/tool-tests/result.txt"] })).rejects.toMatchObject({
      code: "OPERATIONS_DISABLED"
    });
    await expect(disabledCleanup.cleanup({ paths: [".chatgpt/tool-tests/result.txt"] })).rejects.toMatchObject({
      code: "CLEANUP_DISABLED"
    });
  });

  test("cleanup rejects empty paths", async () => {
    const fixture = await createCleanupFixture();
    const service = createService(fixture.root);

    await expect(service.cleanup({ paths: [] })).rejects.toMatchObject({
      code: "CLEANUP_PATHS_REQUIRED"
    });
  });
});

function createService(root: string, config: OperationsPolicyConfig = {}) {
  return new CleanupService(root, new OperationsPolicy({
    enabled: true,
    cleanup_enabled: true,
    cleanup_allowed_globs: [
      ".chatgpt/tool-tests/**",
      ".chatgpt/backups/**",
      ".chatgpt/audits/**",
      ".chatgpt/backlog/**",
      ".chatgpt/codex-runs/**",
      "coverage/**",
      "dist/**",
      "test-results/**"
    ],
    ...config
  }));
}

async function createCleanupFixture(options: { includeSymlink?: boolean } = {}): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "repo-reader-cleanup-"));
  const outside = await mkdtemp(join(tmpdir(), "repo-reader-cleanup-outside-"));
  await mkdir(join(root, ".chatgpt", "tool-tests", "nested"), { recursive: true });
  await mkdir(join(root, ".chatgpt", "backups", "repo_write_file"), { recursive: true });
  await mkdir(join(root, ".chatgpt", "audits"), { recursive: true });
  await mkdir(join(root, ".chatgpt", "backlog"), { recursive: true });
  await mkdir(join(root, ".chatgpt", "codex-runs", "2026-06-04T081500Z-fix-login-expiry"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, ".chatgpt", "tool-tests", "result.txt"), "temporary\n");
  await writeFile(join(root, ".chatgpt", "tool-tests", "nested", "deep.txt"), "temporary\n");
  await writeFile(join(root, ".chatgpt", "backups", "repo_write_file", "old.bak"), "backup\n");
  await writeFile(join(root, ".chatgpt", "codex-runs", "2026-06-04T081500Z-fix-login-expiry", "RESULT.md"), "# CODEX_RESULT\n");
  await writeFile(join(root, ".git", "config"), "[core]\n");
  await writeFile(join(root, ".env"), "TOKEN=value\n");
  await writeFile(join(root, "docs", "notes.md"), "notes\n");
  await writeFile(join(outside, "outside.txt"), "outside\n");
  if (options.includeSymlink) {
    await symlink(join(outside, "outside.txt"), join(root, ".chatgpt", "tool-tests", "outside-link.txt"));
  }
  return { root, outside };
}

async function createGitCleanupFixture(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "repo-reader-cleanup-git-"));
  await mkdir(join(root, ".chatgpt", "audits"), { recursive: true });
  await writeFile(join(root, ".chatgpt", "audits", "tracked.md"), "tracked\n");
  await writeFile(join(root, ".chatgpt", "audits", "2026-06-02-write-handoff-runtime-smoke.md"), "temporary\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["add", "--", ".chatgpt/audits/tracked.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return { root };
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd, env: { PATH: process.env.PATH ?? "" } });
}
