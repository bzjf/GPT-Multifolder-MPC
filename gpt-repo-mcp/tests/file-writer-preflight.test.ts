import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FileWriter } from "../src/services/file-writer.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("FileWriter prepared-write validation", () => {
  test("rejects a stale prepared write before overwriting newer content", async () => {
    const fixture = await createRepoFixture();
    const writer = new FileWriter(
      fixture.root,
      new PathSandbox(fixture.root),
      new WritePolicy({ enabled: true })
    );
    const prepared = await writer.prepareWrite({
      path: "docs/guide.md",
      content: "# Prepared update\n"
    });

    await writeFile(join(fixture.root, "docs", "guide.md"), "# External update\n");

    await expect(writer.commitPrepared(prepared)).rejects.toMatchObject({
      code: "WRITE_STALE_EXPECTED_SHA",
      retryable: true
    });
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# External update\n");
  });

  test("revalidates a prepared no-op before returning success", async () => {
    const fixture = await createRepoFixture();
    const writer = new FileWriter(
      fixture.root,
      new PathSandbox(fixture.root),
      new WritePolicy({ enabled: true })
    );
    const prepared = await writer.prepareWrite({
      path: "docs/guide.md",
      content: "# Guide\nSearchable docs\n"
    });
    expect(prepared.result.changed).toBe(false);

    await writeFile(join(fixture.root, "docs", "guide.md"), "# External update\n");

    await expect(writer.commitPrepared(prepared)).rejects.toMatchObject({
      code: "WRITE_STALE_EXPECTED_SHA",
      retryable: true
    });
  });

  test("rejects a target created after write preparation", async () => {
    const fixture = await createRepoFixture();
    const writer = new FileWriter(
      fixture.root,
      new PathSandbox(fixture.root),
      new WritePolicy({ enabled: true })
    );
    const prepared = await writer.prepareWrite({
      path: "docs/new.md",
      content: "Prepared\n"
    });

    await writeFile(join(fixture.root, "docs", "new.md"), "External\n");

    await expect(writer.commitPrepared(prepared)).rejects.toMatchObject({
      code: "WRITE_TARGET_EXISTS",
      retryable: true
    });
    await expect(readFile(join(fixture.root, "docs", "new.md"), "utf8")).resolves.toBe("External\n");
  });

  test("rejects an existing target removed after write preparation", async () => {
    const fixture = await createRepoFixture();
    const writer = new FileWriter(
      fixture.root,
      new PathSandbox(fixture.root),
      new WritePolicy({ enabled: true })
    );
    const prepared = await writer.prepareWrite({
      path: "docs/guide.md",
      content: "# Prepared update\n"
    });

    await rm(join(fixture.root, "docs", "guide.md"));

    await expect(writer.commitPrepared(prepared)).rejects.toMatchObject({
      code: "WRITE_TARGET_MISSING",
      retryable: true
    });
  });
});
