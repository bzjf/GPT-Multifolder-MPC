import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WriteChangesService } from "../src/services/write-changes-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy, type WritePolicyConfig } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("WriteChangesService polish", () => {
  test("write changes create missing parent directories", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    const result = await service.apply({
      changes: [
        { type: "write", path: "src/generated/client.ts", content: "export const client = true;\n" }
      ]
    });

    expect(result.changed_paths).toEqual(["src/generated/client.ts"]);
    await expect(readFile(join(fixture.root, "src", "generated", "client.ts"), "utf8")).resolves.toBe("export const client = true;\n");
  });

  test("duplicate target paths are rejected", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/guide.md", content: "# Updated\n" },
        { type: "append", path: "./docs/guide.md", content: "More\n" }
      ]
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

function createService(root: string, policy: WritePolicyConfig) {
  return new WriteChangesService(root, new PathSandbox(root), new WritePolicy(policy));
}
