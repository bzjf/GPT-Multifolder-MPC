import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { OperationReceiptService } from "../src/services/operation-receipt-service.js";

describe("OperationReceiptService", () => {
  test("missing last write returns not found with warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const result = await new OperationReceiptService(root).readLastWrite("fixture");

    expect(result).toEqual({
      ok: true,
      found: false,
      next_tool_payloads: {},
      warnings: ["NO_LAST_WRITE_RECEIPT"]
    });
  });

  test("writes and reads safe last write receipt metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const service = new OperationReceiptService(root);

    const writeResult = await service.writeLastWrite({
      tool: "repo_write_changes",
      repo_id: "fixture",
      head_sha_before: "a".repeat(40),
      head_sha_after: "b".repeat(40),
      touched_paths: ["docs/a.md", "src/app.ts"],
      changed_paths: ["docs/a.md", "src/app.ts"],
      created_paths: ["docs/a.md"],
      modified_paths: ["src/app.ts"],
      counts: { requested: 2, changed: 2, created: 1, unchanged: 0 },
      summary: "Applied 2 changes across 2 files."
    });

    expect(writeResult).toEqual({
      ok: true,
      operation_receipt: {
        operation_id: expect.stringMatching(/^write-/),
        path: ".chatgpt/operations/last-write.json"
      },
      warnings: []
    });

    const result = await service.readLastWrite("fixture");
    expect(result).toMatchObject({
      ok: true,
      found: true,
      receipt: {
        schema_version: 1,
        operation_id: writeResult.operation_receipt?.operation_id,
        tool: "repo_write_changes",
        repo_id: "fixture",
        touched_paths: ["docs/a.md", "src/app.ts"],
        changed_paths: ["docs/a.md", "src/app.ts"],
        created_paths: ["docs/a.md"],
        modified_paths: ["src/app.ts"],
        counts: { requested: 2, changed: 2, created: 1, unchanged: 0 },
        summary: "Applied 2 changes across 2 files."
      },
      next_tool_payloads: {
        repo_git_review: { repo_id: "fixture" }
      },
      warnings: []
    });

    const serialized = await readFile(join(root, ".chatgpt", "operations", "last-write.json"), "utf8");
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("/tmp/");
    expect(serialized).not.toContain(root);
  });

  test("invalid receipt content is treated as missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    await mkdir(join(root, ".chatgpt", "operations"), { recursive: true });
    await writeFile(join(root, ".chatgpt", "operations", "last-write.json"), JSON.stringify({
      schema_version: 1,
      operation_id: "write-test",
      tool: "repo_write_file",
      repo_id: "fixture",
      timestamp: new Date().toISOString(),
      touched_paths: ["/tmp/leak.md"],
      changed_paths: ["/tmp/leak.md"],
      created_paths: [],
      modified_paths: ["/tmp/leak.md"],
      counts: { requested: 1, changed: 1, created: 0, unchanged: 0 },
      summary: "Updated /tmp/leak.md."
    }));

    const result = await new OperationReceiptService(root).readLastWrite("fixture");

    expect(result).toEqual({
      ok: true,
      found: false,
      next_tool_payloads: {},
      warnings: ["INVALID_LAST_WRITE_RECEIPT"]
    });
  });
});
