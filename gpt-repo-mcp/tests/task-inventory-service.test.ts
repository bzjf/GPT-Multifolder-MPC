import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_LIMITS } from "../src/policies/limits.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { TaskInventoryService } from "../src/services/task-inventory-service.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("TaskInventoryService", () => {
  test("finds TODO, FIXME, HACK, checkbox, and roadmap items", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "TODO.md"), [
      "# Tasks",
      "- [ ] Add onboarding flow",
      "- [x] Keep completed task visible",
      "Roadmap: support write tools later",
      ""
    ].join("\n"));
    await writeFile(join(fixture.root, "src", "tasks.ts"), [
      "export const value = 1;",
      "// TODO: tighten validation",
      "// FIXME: handle empty state",
      "// HACK: temporary fixture",
      ""
    ].join("\n"));

    const result = await new TaskInventoryService(fixture.root, new PathSandbox(fixture.root)).inventory();

    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "TODO.md", line: 2, kind: "checkbox", text: "Add onboarding flow" }),
      expect.objectContaining({ path: "TODO.md", line: 3, kind: "checkbox", text: "Keep completed task visible" }),
      expect.objectContaining({ path: "TODO.md", line: 4, kind: "roadmap" }),
      expect.objectContaining({ path: "src/tasks.ts", line: 2, kind: "todo" }),
      expect.objectContaining({ path: "src/tasks.ts", line: 3, kind: "fixme" }),
      expect.objectContaining({ path: "src/tasks.ts", line: 4, kind: "hack" })
    ]));
    expect(result.matched_count).toBe(6);
    expect(result.returned_count).toBe(6);
    expect(result.scanned_file_count).toBeGreaterThanOrEqual(2);
    expect(result.scan_complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  test("supports labels, globs, and pagination", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "one.ts"), "// TODO: one\n// FIXME: two\n");
    await writeFile(join(fixture.root, "docs", "tasks.md"), "- [ ] docs task\n");

    const service = new TaskInventoryService(fixture.root, new PathSandbox(fixture.root));
    const first = await service.inventory({
      include_globs: ["src/**/*.ts"],
      labels: ["todo", "fixme"],
      max_results: 1
    });

    expect(first.tasks.map((task) => task.kind)).toEqual(["todo"]);
    expect(first.matched_count).toBe(2);
    expect(first.scan_complete).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe("1");

    const second = await service.inventory({
      include_globs: ["src/**/*.ts"],
      labels: ["todo", "fixme"],
      max_results: 1,
      cursor: first.next_cursor
    });

    expect(second.tasks.map((task) => task.kind)).toEqual(["fixme"]);
    expect(second.scan_complete).toBe(true);
    expect(second.truncated).toBe(false);
  });

  test("scans internal tree pages before paginating task results", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "many"), { recursive: true });
    for (let index = 0; index < 2005; index += 1) {
      await writeFile(join(fixture.root, "many", `file-${String(index).padStart(4, "0")}.ts`), "export const value = true;\n");
    }
    await writeFile(join(fixture.root, "many", "file-2004.ts"), "// TODO: task past first tree page\n");

    const result = await new TaskInventoryService(fixture.root, new PathSandbox(fixture.root)).inventory({
      include_globs: ["many/**/*.ts"]
    });

    expect(result.tasks).toEqual([
      expect.objectContaining({ path: "many/file-2004.ts", kind: "todo" })
    ]);
    expect(result.matched_count).toBe(1);
    expect(result.scan_complete).toBe(true);
    expect(result.warnings).not.toContain("SCAN_TREE_PAGE_LIMIT_REACHED");
  });

  test("reports file limit instead of tree page limit when file cap stops scan first", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "many"), { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      await writeFile(join(fixture.root, "many", `file-${String(index).padStart(2, "0")}.ts`), "// TODO: task\n");
    }

    const previousFileLimit = DEFAULT_LIMITS.max_task_inventory_files;
    const previousTreeEntries = DEFAULT_LIMITS.max_tree_entries;
    try {
      (DEFAULT_LIMITS as { max_task_inventory_files: number }).max_task_inventory_files = 3;
      (DEFAULT_LIMITS as { max_tree_entries: number }).max_tree_entries = 4;

      const result = await new TaskInventoryService(fixture.root, new PathSandbox(fixture.root)).inventory({
        include_globs: ["many/**/*.ts"]
      });

      expect(result.scan_complete).toBe(false);
      expect(result.warnings).toContain("SCAN_FILE_LIMIT_REACHED");
      expect(result.warnings).not.toContain("SCAN_TREE_PAGE_LIMIT_REACHED");
    } finally {
      (DEFAULT_LIMITS as { max_task_inventory_files: number }).max_task_inventory_files = previousFileLimit;
      (DEFAULT_LIMITS as { max_tree_entries: number }).max_tree_entries = previousTreeEntries;
    }
  });

  test("reports bounded file reads while scanning tasks", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "large.ts"), `// TODO: visible task\n${"x".repeat(130_000)}\n`);

    const result = await new TaskInventoryService(fixture.root, new PathSandbox(fixture.root)).inventory({
      include_globs: ["src/large.ts"]
    });

    expect(result.tasks).toEqual([
      expect.objectContaining({ path: "src/large.ts", kind: "todo" })
    ]);
    expect(result.scan_complete).toBe(true);
    expect(result.warnings).toContain("FILE_TRUNCATED:src/large.ts");
  });

  test("skips secret candidates, default excludes, and binary files", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, ".env"), "TODO=do-not-return\n");
    await writeFile(join(fixture.root, "node_modules", "pkg", "todo.js"), "// TODO: ignored dependency\n");
    await writeFile(join(fixture.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));

    const result = await new TaskInventoryService(fixture.root, new PathSandbox(fixture.root)).inventory();

    expect(result.tasks.map((task) => task.path)).not.toContain(".env");
    expect(result.tasks.map((task) => task.path)).not.toContain("node_modules/pkg/todo.js");
    expect(result.tasks.map((task) => task.path)).not.toContain("binary.bin");
  });
});
