import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { RootRegistry } from "../../src/services/root-registry.js";
import { editContextHandler } from "../../src/tools/handlers.js";
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

  test("reads more than the former 20-file cap when repository limits allow it", async () => {
    const fixture = await createRepoFixture();
    const knownPaths = Array.from({ length: 25 }, (_, index) => `docs/capacity-${index}.md`);
    await Promise.all(knownPaths.map((path, index) =>
      writeFile(join(fixture.root, path), `capacity file ${index}\n`)
    ));
    const registry = await RootRegistry.fromConfig({
      repos: [{ repo_id: "fixture", display_name: "Fixture", root: fixture.root }],
      limits: { max_files: 30, max_bytes_per_file: 256_000, max_total_bytes: 1_500_000 }
    });

    const result = await editContextHandler({
      repo_id: "fixture",
      goal: "Read the supplied capacity fixtures",
      search_queries: ["capacity-marker-that-does-not-exist"],
      known_paths: knownPaths,
      max_search_results_per_query: 1,
      max_files_to_read: 25
    }, { registry });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      returned_file_count: 25,
      truncated: false
    });
  });

  test("ranks candidates and removes search context duplicated by returned files", async () => {
    const { fixture, context } = await createContext();
    await writeFile(join(fixture.root, "src", "multi.ts"), "alpha beta alpha\n");
    await writeFile(join(fixture.root, "src", "single.ts"), "alpha\n");

    const response = await editContextHandler({
      repo_id: "fixture",
      goal: "Rank edit candidates",
      search_queries: ["alpha", "beta"],
      known_paths: ["docs/guide.md"],
      max_files_to_read: 2,
      context_lines: 2
    }, context);

    const payload = response.structuredContent as {
      candidate_paths: Array<{ path: string; reason: string }>;
      files: Array<{ path: string }>;
      searches: Array<{ results: Array<{ path: string; before: string[]; after: string[] }> }>;
    };
    expect(payload.candidate_paths.slice(0, 3).map((candidate) => candidate.path)).toEqual([
      "docs/guide.md",
      "src/multi.ts",
      "src/single.ts"
    ]);
    expect(payload.candidate_paths[1]?.reason).toContain("across 2 queries");
    expect(payload.files.map((file) => file.path)).toEqual(["docs/guide.md", "src/multi.ts"]);
    expect(payload.searches.flatMap((search) => search.results)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/multi.ts", before: [], after: [] })
    ]));
    expect(payload.searches.flatMap((search) => search.results).some((match) => match.path === "src/single.ts")).toBe(false);
  });

  test("uses compact defaults and provides a cursor for remaining ranked candidates", async () => {
    const fixture = await createRepoFixture();
    const knownPaths = Array.from({ length: 10 }, (_, index) => `docs/default-${index}.md`);
    await Promise.all(knownPaths.map((path, index) =>
      writeFile(join(fixture.root, path), `default file ${index}\n`)
    ));
    const registry = await RootRegistry.fromConfig({
      repos: [{ repo_id: "fixture", display_name: "Fixture", root: fixture.root }],
      limits: { max_files: 20, max_bytes_per_file: 256_000, max_total_bytes: 1_500_000 }
    });

    const response = await editContextHandler({
      repo_id: "fixture",
      goal: "Read default context page",
      search_queries: ["missing-default-marker"],
      known_paths: knownPaths
    }, { registry });

    const payload = response.structuredContent as {
      returned_file_count: number;
      truncated: boolean;
      next_cursor?: string;
      next_tool_hints: {
        repo_read_many?: { paths?: string[]; max_files?: number; max_total_bytes?: number; cursor?: string };
      };
    };
    expect(payload.returned_file_count).toBe(8);
    expect(payload.truncated).toBe(true);
    expect(payload.next_cursor).toBe("8");
    expect(payload.next_tool_hints.repo_read_many).toMatchObject({
      paths: knownPaths,
      max_files: 8,
      max_total_bytes: 300_000,
      cursor: "8"
    });
  });

  test("audits edit-context phase timings, result size, and search backend", async () => {
    const { context } = await createContext();
    const originalFormat = process.env.GPT_REPO_LOG_FORMAT;
    process.env.GPT_REPO_LOG_FORMAT = "json";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await editContextHandler({
        repo_id: "fixture",
        goal: "Inspect raw fetch",
        search_queries: ["rawFetch"],
        known_paths: ["src/app.ts"]
      }, context);

      const lines = error.mock.calls.map((call) => String(call[0] ?? ""));
      const auditLine = lines.find((line) => line.includes('"tool":"repo_edit_context"')) ?? "{}";
      const event = JSON.parse(auditLine) as {
        details?: Record<string, string | number>;
      };
      expect(event.details).toMatchObject({
        search_ms: expect.any(Number),
        read_ms: expect.any(Number),
        git_head_ms: expect.any(Number),
        result_bytes: Buffer.byteLength(JSON.stringify(response.structuredContent), "utf8"),
        search_backend: expect.stringMatching(/^(ripgrep|typescript)$/)
      });
    } finally {
      error.mockRestore();
      if (originalFormat === undefined) {
        delete process.env.GPT_REPO_LOG_FORMAT;
      } else {
        process.env.GPT_REPO_LOG_FORMAT = originalFormat;
      }
    }
  });
});
