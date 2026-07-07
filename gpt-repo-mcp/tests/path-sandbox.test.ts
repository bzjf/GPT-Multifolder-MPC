import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createDirectoryLinkIfSupported } from "./helpers/symlink.js";

describe("PathSandbox", () => {
  test("rejects absolute model-supplied paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("/etc/passwd")).rejects.toMatchObject({
      code: "ABSOLUTE_PATH_REJECTED"
    });
  });

  test("rejects path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("../outside.txt")).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED"
    });
  });

  test("rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const outside = await mkdtemp(join(tmpdir(), "repo-reader-outside-"));
    const linked = await createDirectoryLinkIfSupported(outside, join(root, "linked-outside"));
    if (!linked) return;

    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("linked-outside")).rejects.toMatchObject({
      code: "SYMLINK_ESCAPE_REJECTED"
    });
  });

  test("detects nested repositories without treating them as normal files", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    await mkdir(join(root, "vendor", "lib", ".git"), { recursive: true });

    const sandbox = new PathSandbox(root);
    const result = await sandbox.classifyBoundary("vendor/lib");

    expect(result).toEqual({ kind: "nested_repo", path: "vendor/lib" });
  });
});
