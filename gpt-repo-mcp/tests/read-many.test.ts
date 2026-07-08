import { describe, expect, test } from "vitest";
import { RootRegistry } from "../src/services/root-registry.js";
import type { ReadManyResult } from "../src/services/read-many-service.js";
import { readManyHandler } from "../src/tools/handlers.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

async function createContext() {
  const fixture = await createRepoFixture();
  const registry = await RootRegistry.fromConfig({
    repos: [{ repo_id: "fixture", display_name: "Fixture", root: fixture.root }],
    limits: { max_files: 3, max_bytes_per_file: 128_000, max_total_bytes: 750_000 }
  });
  return { fixture, context: { registry } };
}

describe("repo_read_many", () => {
  test("rejects calls without paths or include globs", async () => {
    const { context } = await createContext();

    const result = await readManyHandler({ repo_id: "fixture" }, context);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta?.error).toEqual({
      code: "VALIDATION_ERROR",
      message: "repo_read_many requires paths or include_globs.",
      retryable: false
    });
  });

  test("rejects an invalid batch cursor", async () => {
    const { context } = await createContext();

    const result = await readManyHandler({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      cursor: "not-a-number"
    }, context);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta?.error).toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  test("reads explicit files and reports policy-blocked files as skipped", async () => {
    const { context } = await createContext();

    const result = await callReadMany({
      repo_id: "fixture",
      paths: ["src/app.ts", ".env", "binary.bin"]
    }, context);

    expect(result.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(result.skipped).toEqual([
      { path: ".env", reason: "SECRET_CANDIDATE_BLOCKED" },
      { path: "binary.bin", reason: "BINARY_FILE_REJECTED" }
    ]);
    expect(result.matched_count).toBe(3);
    expect(result.returned_count).toBe(1);
  });

  test("supports include and exclude globs", async () => {
    const { context } = await createContext();

    const result = await callReadMany({
      repo_id: "fixture",
      include_globs: ["src/**/*.controller.ts"],
      exclude_globs: ["src/admin.*"]
    }, context);

    expect(result.files.map((file) => file.path)).toEqual(["src/users.controller.ts"]);
    expect(result.skipped).toEqual([]);
  });

  test("enforces max_files with a resumable cursor", async () => {
    const { context } = await createContext();

    const first = await callReadMany({
      repo_id: "fixture",
      paths: ["src/app.ts", "src/controllers.ts", "src/admin.controller.ts"],
      max_files: 2
    }, context);

    expect(first.files.map((file) => file.path)).toEqual(["src/app.ts", "src/controllers.ts"]);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe("2");

    const second = await callReadMany({
      repo_id: "fixture",
      paths: ["src/app.ts", "src/controllers.ts", "src/admin.controller.ts"],
      max_files: 2,
      cursor: first.next_cursor
    }, context);

    expect(second.files.map((file) => file.path)).toEqual(["src/admin.controller.ts"]);
    expect(second.truncated).toBe(false);
    expect(second.next_cursor).toBeUndefined();
  });

  test("uses the remaining total-byte budget for a bounded chunk of the next file", async () => {
    const { context } = await createContext();

    const result = await callReadMany({
      repo_id: "fixture",
      paths: ["src/app.ts", "src/controllers.ts"],
      max_total_bytes: 70
    }, context);

    expect(result.files.map((file) => file.path)).toEqual(["src/app.ts", "src/controllers.ts"]);
    expect(result.files.reduce((total, file) => total + file.returned_bytes, 0)).toBe(70);
    expect(result.files[1]?.truncated).toBe(true);
    expect(result.files[1]?.next_cursor).toEqual(expect.any(String));
    expect(result.skipped).toEqual([]);
  });
});

async function callReadMany(
  input: Parameters<typeof readManyHandler>[0],
  context: Awaited<ReturnType<typeof createContext>>["context"]
): Promise<ReadManyResult> {
  const result = await readManyHandler(input, context);
  return result.structuredContent as ReadManyResult;
}
