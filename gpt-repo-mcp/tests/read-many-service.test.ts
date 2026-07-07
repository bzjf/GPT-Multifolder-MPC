import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { ReadManyService } from "../src/services/read-many-service.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("ReadManyService", () => {
  test("rejects a cursor beyond the matched file list", async () => {
    const fixture = await createRepoFixture();
    const service = new ReadManyService(
      fixture.root,
      new PathSandbox(fixture.root),
      {
        max_files: 50,
        max_bytes_per_file: 128,
        max_total_bytes: 512,
        max_line_scan_bytes: 1_024
      }
    );

    await expect(service.readMany({ paths: ["README.md"], cursor: "2" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  test("clamps caller limits to configured per-file and total-byte caps", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "a.txt"), "a".repeat(200));
    await writeFile(join(fixture.root, "docs", "b.txt"), "b".repeat(200));
    await writeFile(join(fixture.root, "docs", "c.txt"), "c".repeat(200));

    const service = new ReadManyService(
      fixture.root,
      new PathSandbox(fixture.root),
      {
        max_files: 50,
        max_bytes_per_file: 32,
        max_total_bytes: 40,
        max_line_scan_bytes: 1_024
      }
    );

    const result = await service.readMany({
      paths: ["docs/a.txt", "docs/b.txt", "docs/c.txt"],
      max_files: 500,
      max_bytes_per_file: 10_000,
      max_total_bytes: 10_000
    });

    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.returned_bytes <= 32)).toBe(true);
    expect(result.files.reduce((total, file) => total + file.returned_bytes, 0)).toBe(40);
    expect(result.truncated).toBe(true);
    expect(result.next_cursor).toBe("2");
  });

  test("does not consume the next file when the remaining byte budget cannot hold one UTF-8 character", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "ascii.txt"), "a".repeat(9));
    await writeFile(join(fixture.root, "docs", "chinese.txt"), "甲乙");

    const service = new ReadManyService(
      fixture.root,
      new PathSandbox(fixture.root),
      {
        max_files: 50,
        max_bytes_per_file: 10,
        max_total_bytes: 10,
        max_line_scan_bytes: 1_024
      }
    );

    const first = await service.readMany({ paths: ["docs/ascii.txt", "docs/chinese.txt"] });
    expect(first.files).toHaveLength(1);
    expect(first.files[0]?.returned_bytes).toBe(9);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe("1");

    const second = await service.readMany({
      paths: ["docs/ascii.txt", "docs/chinese.txt"],
      cursor: first.next_cursor
    });
    expect(second.files[0]?.text).toBe("甲乙");
  });
});
