import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WriteChangesService } from "../src/services/write-changes-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy, type WritePolicyConfig } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("WriteChangesService diagnostics", () => {
  test("unsafe preflight failure does not apply earlier prepared paths", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["docs/**"] });
    const unsafePath = ["..", "outside.md"].join("/");

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/preflight/new.md", content: "A\n" },
        { type: "write", path: unsafePath, content: "outside\n" }
      ]
    })).rejects.toMatchObject({ code: "PATH_TRAVERSAL_REJECTED" });
    await expect(access(join(fixture.root, "docs", "preflight"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createService(root: string, policy: WritePolicyConfig) {
  return new WriteChangesService(root, new PathSandbox(root), new WritePolicy(policy));
}
