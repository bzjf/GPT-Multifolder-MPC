import { describe, expect, test } from "vitest";
import { RootRegistry } from "../src/services/root-registry.js";
import { editContextHandler } from "../src/tools/handlers.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

async function createContext() {
  const fixture = await createRepoFixture();
  const registry = await RootRegistry.fromConfig({
    repos: [{ repo_id: "fixture", display_name: "Fixture", root: fixture.root }],
    limits: { max_files: 5, max_bytes_per_file: 128_000, max_total_bytes: 750_000 }
  });
  return { fixture, context: { registry } };
}

describe("repo_edit_context", () => {
  test("combines search, candidate selection, and batched file reads", async () => {
    const { context } = await createContext();

    const result = await editContextHandler({
      repo_id: "fixture",
      goal: "Replace rawFetch and inspect controller references",
      search_queries: ["rawFetch", "controller"],
      known_paths: ["docs/guide.md"],
      max_search_results_per_query: 3,
      max_files_to_read: 3
    }, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      repo_id: "fixture",
      goal: "Replace rawFetch and inspect controller references",
      returned_file_count: expect.any(Number),
      next_tool_hints: {
        repo_write_changes: { repo_id: "fixture" },
        repo_git_review: { repo_id: "fixture" }
      }
    });

    const payload = result.structuredContent as {
      searches: Array<{ query: string; returned_count: number }>;
      candidate_paths: Array<{ path: string; source_queries: string[] }>;
      files: Array<{ path: string; text: string }>;
      warnings: string[];
    };
    expect(payload.searches.map((search) => search.query)).toEqual(["rawFetch", "controller"]);
    expect(payload.candidate_paths.map((candidate) => candidate.path)).toContain("docs/guide.md");
    expect(payload.candidate_paths.map((candidate) => candidate.path)).toContain("src/app.ts");
    expect(payload.files.map((file) => file.path)).toContain("docs/guide.md");
    expect(payload.files.map((file) => file.path)).toContain("src/app.ts");
    expect(payload.files.find((file) => file.path === "src/app.ts")?.text).toContain("rawFetch");
    expect(payload.warnings).toContain("GIT_HEAD_UNAVAILABLE");
  });
});