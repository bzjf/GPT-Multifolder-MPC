import { describe, expect, test } from "vitest";
import { DEFAULT_LIMITS } from "../../src/policies/limits.js";
import { RootRegistry } from "../../src/services/root-registry.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("RootRegistry", () => {
  test("uses the elevated bounded read-capacity profile", () => {
    expect(DEFAULT_LIMITS).toEqual({
      max_files: 100,
      max_bytes_per_file: 256_000,
      max_total_bytes: 1_500_000,
      max_line_scan_bytes: 128 * 1024 * 1024,
      max_search_results: 250,
      max_tree_entries: 5_000,
      max_task_inventory_files: 10_000,
      max_task_inventory_tree_pages: 40,
      max_task_inventory_file_bytes: 256_000,
      max_project_brief_doc_bytes: 64_000,
      max_decision_log_source_bytes: 64_000,
      max_decision_log_sources: 40,
      max_change_plan_files: 60,
      max_change_plan_tree_pages: 10,
      max_depth: 12,
      default_diff_bytes: 32_000,
      max_diff_bytes: 512_000
    });
  });

  test("resolves the full configured limits surface", async () => {
    const fixture = await createRepoFixture();
    const configuredLimits = {
      max_files: 7,
      max_bytes_per_file: 11,
      max_total_bytes: 13,
      max_line_scan_bytes: 17,
      max_search_results: 19,
      max_tree_entries: 23,
      max_task_inventory_files: 29,
      max_task_inventory_tree_pages: 31,
      max_task_inventory_file_bytes: 37,
      max_project_brief_doc_bytes: 41,
      max_decision_log_source_bytes: 43,
      max_decision_log_sources: 47,
      max_change_plan_files: 53,
      max_change_plan_tree_pages: 59,
      max_depth: 61,
      default_diff_bytes: 63,
      max_diff_bytes: 67
    };

    const registry = await RootRegistry.fromConfig({
      repos: [{
        repo_id: "fixture",
        display_name: "Fixture",
        root: fixture.root,
        allow_non_git: true,
        writes: { enabled: true }
      }],
      limits: configuredLimits
    });

    expect(registry.limits).toMatchObject(configuredLimits);
    expect(Object.keys(registry.limits).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
    expect(registry.get("fixture").allow_non_git).toBe(true);
    expect(registry.get("fixture").writes?.enabled).toBe(true);
    expect(registry.get("fixture").writes?.max_bytes_per_write).toBe(1048576);
  });
});
