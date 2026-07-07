import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WriteChangesService } from "../src/services/write-changes-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";
import { createDirectoryLinkIfSupported } from "./helpers/symlink.js";

describe("WriteChangesService target conflict validation", () => {
  test("rejects parent and child target paths before writing either", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/conflict", content: "file\n" },
        { type: "write", path: "docs/conflict/child.md", content: "child\n" }
      ]
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(access(join(fixture.root, "docs", "conflict"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects trailing-slash aliases of the same target", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/same.md", content: "one\n" },
        { type: "write", path: "docs/same.md/", content: "two\n" }
      ]
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(access(join(fixture.root, "docs", "same.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects in-repo symlink aliases that resolve to the same new target", async () => {
    const fixture = await createRepoFixture();
    const linked = await createDirectoryLinkIfSupported(
      join(fixture.root, "docs"),
      join(fixture.root, "docs-alias")
    );
    if (!linked) return;
    const service = new WriteChangesService(
      fixture.root,
      new PathSandbox(fixture.root),
      new WritePolicy({ enabled: true, allowed_globs: ["docs/**", "docs-alias/**"] })
    );

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/alias.md", content: "one\n" },
        { type: "write", path: "docs-alias/alias.md", content: "two\n" }
      ]
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(access(join(fixture.root, "docs", "alias.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects case aliases on commonly case-insensitive platforms", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/Case.md", content: "one\n" },
        { type: "write", path: "docs/case.md", content: "two\n" }
      ]
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

function createService(root: string): WriteChangesService {
  return new WriteChangesService(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: ["docs/**"] })
  );
}
