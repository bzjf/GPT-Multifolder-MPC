import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_LIMITS } from "../src/policies/limits.js";
import { ChangePlanService } from "../src/services/change-plan-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("ChangePlanService", () => {
  test("creates an evidence-grounded implementation plan", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "tests"), { recursive: true });
    await writeFile(join(fixture.root, "src", "validation.ts"), "export function validateFixture() { return true; }\n");
    await writeFile(join(fixture.root, "tests", "validation.test.ts"), "test('validation', () => {});\n");
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest",
        typecheck: "tsc --noEmit"
      }
    }, null, 2));

    const result = await new ChangePlanService(fixture.root, new PathSandbox(fixture.root)).plan({
      goal: "Add fixture validation",
      planning_depth: "standard"
    });

    expect(result.goal).toBe("Add fixture validation");
    expect(result.relevant_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/validation.ts" }),
      expect.objectContaining({ path: "tests/validation.test.ts" })
    ]));
    expect(result.proposed_steps.length).toBeGreaterThan(0);
    expect(result.test_strategy).toEqual(expect.arrayContaining([
      expect.stringContaining("targeted tests"),
      expect.stringContaining("typecheck")
    ]));
    expect(result.scan_complete).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("honors include globs and quick planning depth", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "alpha.ts"), "export const alpha = true;\n");
    await writeFile(join(fixture.root, "docs", "alpha.md"), "Alpha docs\n");

    const result = await new ChangePlanService(fixture.root, new PathSandbox(fixture.root)).plan({
      goal: "Change alpha behavior",
      include_globs: ["src/**/*.ts"],
      planning_depth: "quick"
    });

    expect(result.relevant_files.every((file) => file.path.startsWith("src/"))).toBe(true);
    expect(result.proposed_steps).toHaveLength(3);
  });

  test("reports incomplete tree scans", async () => {
    const previousTreeEntries = DEFAULT_LIMITS.max_tree_entries;
    const previousTreePages = DEFAULT_LIMITS.max_change_plan_tree_pages;
    const fixture = await createRepoFixture();
    try {
      (DEFAULT_LIMITS as { max_tree_entries: number }).max_tree_entries = 4;
      (DEFAULT_LIMITS as { max_change_plan_tree_pages: number }).max_change_plan_tree_pages = 1;
      await mkdir(join(fixture.root, "many"), { recursive: true });
      for (let index = 0; index < 12; index += 1) {
        await writeFile(join(fixture.root, "many", `file-${String(index).padStart(2, "0")}.ts`), "export const value = true;\n");
      }

      const result = await new ChangePlanService(fixture.root, new PathSandbox(fixture.root)).plan({
        goal: "Change value",
        planning_depth: "deep"
      });

      expect(result.scan_complete).toBe(false);
      expect(result.warnings).toContain("TREE_SCAN_INCOMPLETE");
    } finally {
      (DEFAULT_LIMITS as { max_tree_entries: number }).max_tree_entries = previousTreeEntries;
      (DEFAULT_LIMITS as { max_change_plan_tree_pages: number }).max_change_plan_tree_pages = previousTreePages;
    }
  });
});
