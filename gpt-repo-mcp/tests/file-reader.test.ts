import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FileReader } from "../src/services/file-reader.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("FileReader", () => {
  test("returns complete metadata for a small file", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    const result = await reader.read({ path: "src/app.ts" });

    expect(result.mode).toBe("bytes");
    expect(result.truncated).toBe(false);
    expect(result.file_size_bytes).toBe(result.returned_bytes);
    expect(result.size_bytes).toBe(result.returned_bytes);
    expect(result.total_lines).toBe(4);
    expect(result.start_line).toBe(1);
    expect(result.end_line).toBe(4);
    expect(result.byte_start).toBe(0);
    expect(result.byte_end).toBe(result.file_size_bytes);
  });

  test("reads a normal text file with line bounds and metadata", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    const result = await reader.read({ path: "src/app.ts", start_line: 2, end_line: 2 });

    expect(result.path).toBe("src/app.ts");
    expect(result.language).toBe("typescript");
    expect(result.mode).toBe("lines");
    expect(result.total_lines).toBeUndefined();
    expect(result.start_line).toBe(2);
    expect(result.end_line).toBe(2);
    expect(result.text).toBe("  return fetch('/api/users');");
    expect(result.returned_bytes).toBe(Buffer.byteLength(result.text));
    expect(result.chunk_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sha256).toBe(result.chunk_sha256);
  });

  test("paginates a large file instead of rejecting it", async () => {
    const fixture = await createRepoFixture();
    const content = "0123456789".repeat(40_000);
    await writeFile(join(fixture.root, "docs", "large.txt"), content);
    const reader = new FileReader(new PathSandbox(fixture.root), 64);

    const first = await reader.read({ path: "docs/large.txt" });
    expect(first.mode).toBe("bytes");
    expect(first.truncated).toBe(true);
    expect(first.byte_start).toBe(0);
    expect(first.byte_end).toBe(64);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await reader.read({ path: "docs/large.txt", cursor: first.next_cursor });
    expect(second.byte_start).toBe(first.byte_end);
    expect(first.text + second.text).toBe(content.slice(0, second.byte_end));
  });

  test("blocks a secret value that crosses a byte-page boundary", async () => {
    const fixture = await createRepoFixture();
    const unsafeValue = "sk-" + "boundarySecretValue123456789";
    const content = `${"a".repeat(20)}OPENAI_API_KEY=${unsafeValue}\n${"b".repeat(100)}`;
    await writeFile(join(fixture.root, "docs", "paged-sensitive.txt"), content);
    const reader = new FileReader(new PathSandbox(fixture.root), 32);

    await expect(reader.read({ path: "docs/paged-sensitive.txt" })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("redacts a sensitive value wholly contained inside a byte page", async () => {
    const fixture = await createRepoFixture();
    const unsafeValue = "sk-" + "containedValue123456789";
    const content = `OPENAI_API_KEY=${unsafeValue}\n${"b".repeat(200)}`;
    await writeFile(join(fixture.root, "docs", "paged-redaction.txt"), content);
    const reader = new FileReader(new PathSandbox(fixture.root), 64);

    const result = await reader.read({ path: "docs/paged-redaction.txt" });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[REDACTED_SECRET]");
    expect(result.text).not.toContain(unsafeValue);
  });

  test("streams a targeted line range from a large file", async () => {
    const fixture = await createRepoFixture();
    const lines = Array.from({ length: 6_000 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(fixture.root, "docs", "many-lines.txt"), `${lines.join("\n")}\n`);
    const reader = new FileReader(new PathSandbox(fixture.root));

    const result = await reader.read({
      path: "docs/many-lines.txt",
      start_line: 5_000,
      end_line: 5_100
    });

    expect(result.mode).toBe("lines");
    expect(result.start_line).toBe(5_000);
    expect(result.end_line).toBe(5_100);
    expect(result.text).toBe(lines.slice(4_999, 5_100).join("\n"));
    expect(result.truncated).toBe(false);
  });

  test("continues a bounded line range with a cursor", async () => {
    const fixture = await createRepoFixture();
    const lines = Array.from({ length: 10 }, (_, index) => `row-${index + 1}`);
    await writeFile(join(fixture.root, "docs", "line-pages.txt"), lines.join("\n"));
    const reader = new FileReader(new PathSandbox(fixture.root), 13);

    const first = await reader.read({ path: "docs/line-pages.txt", start_line: 2, end_line: 6 });
    expect(first.text).toBe("row-2\nrow-3");
    expect(first.truncated).toBe(true);

    const second = await reader.read({ path: "docs/line-pages.txt", cursor: first.next_cursor });
    expect(second.start_line).toBe(4);
    expect(second.text).toBe("row-4\nrow-5");
    expect(second.truncated).toBe(true);

    const third = await reader.read({ path: "docs/line-pages.txt", cursor: second.next_cursor });
    expect(third.start_line).toBe(6);
    expect(third.text).toBe("row-6");
    expect(third.truncated).toBe(false);
  });

  test("keeps UTF-8 characters intact across byte pages", async () => {
    const fixture = await createRepoFixture();
    const content = "甲乙丙丁戊己庚辛".repeat(20);
    await writeFile(join(fixture.root, "docs", "utf8.txt"), content);
    const reader = new FileReader(new PathSandbox(fixture.root), 10);

    const first = await reader.read({ path: "docs/utf8.txt" });
    expect(first.returned_bytes).toBe(9);
    expect(first.text).not.toContain("�");

    const second = await reader.read({ path: "docs/utf8.txt", cursor: first.next_cursor });
    expect(second.byte_start).toBe(first.byte_end);
    expect(second.text).not.toContain("�");
  });

  test("adjusts a manual byte offset to the next UTF-8 boundary", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "offset.txt"), "甲乙丙");
    const reader = new FileReader(new PathSandbox(fixture.root), 16);

    const result = await reader.read({ path: "docs/offset.txt", byte_offset: 1 });
    expect(result.byte_start).toBe(3);
    expect(result.text).toBe("乙丙");
    expect(result.warnings).toEqual(["Adjusted byte_offset from 1 to UTF-8 boundary 3."]);
  });

  test("rejects a manual byte offset beyond EOF", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: "src/app.ts", byte_offset: 1_000_000 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  test("rejects mutually exclusive line, byte, and cursor selectors", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: "src/app.ts", start_line: 2, end_line: 1 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
    await expect(reader.read({ path: "src/app.ts", start_line: 1, byte_offset: 0 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
    await expect(reader.read({ path: "src/app.ts", cursor: "abc", start_line: 1 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  test("handles CRLF line ranges", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
    const reader = new FileReader(new PathSandbox(fixture.root));

    const result = await reader.read({ path: "docs/crlf.txt", start_line: 2, end_line: 3 });
    expect(result.text).toBe("two\nthree");
    expect(result.start_line).toBe(2);
    expect(result.end_line).toBe(3);
  });

  test("rejects a start line beyond EOF", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: "src/app.ts", start_line: 100 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  test("caps expensive line scans and directs callers to byte pagination", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "scan-limit.txt"), "small-line\n".repeat(100));
    const reader = new FileReader(new PathSandbox(fixture.root), 128, 64);

    await expect(reader.read({ path: "docs/scan-limit.txt", start_line: 50, end_line: 51 })).rejects.toMatchObject({
      code: "SIZE_LIMIT_EXCEEDED"
    });

    const bytes = await reader.read({ path: "docs/scan-limit.txt", byte_offset: 64 });
    expect(bytes.mode).toBe("bytes");
  });

  test("directs oversized single lines to byte pagination", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "one-line.txt"), "x".repeat(500));
    const reader = new FileReader(new PathSandbox(fixture.root), 32);

    await expect(reader.read({ path: "docs/one-line.txt", start_line: 1 })).rejects.toMatchObject({
      code: "LINE_EXCEEDS_MAX_BYTES"
    });

    const bytes = await reader.read({ path: "docs/one-line.txt", byte_offset: 0 });
    expect(bytes.text).toBe("x".repeat(32));
    expect(bytes.truncated).toBe(true);
  });

  test("rejects a stale cursor after the file changes", async () => {
    const fixture = await createRepoFixture();
    const filePath = join(fixture.root, "docs", "changing.txt");
    await writeFile(filePath, "a".repeat(200));
    const reader = new FileReader(new PathSandbox(fixture.root), 32);

    const first = await reader.read({ path: "docs/changing.txt" });
    await writeFile(filePath, "b".repeat(201));

    await expect(reader.read({ path: "docs/changing.txt", cursor: first.next_cursor })).rejects.toMatchObject({
      code: "STALE_CURSOR"
    });
  });

  test("blocks secret candidates even when default excludes are overridden", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: ".env", override_default_excludes: true })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("reads safe files whose paths mention secret or credential", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    await writeFile(join(fixture.root, "docs", "secret-management.md"), "# Secret Management\nUse placeholders.\n");

    const result = await reader.read({ path: "docs/secret-management.md" });

    expect(result.path).toBe("docs/secret-management.md");
    expect(result.text).toContain("Use placeholders.");
  });

  test("still blocks files inside secrets directories", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    await mkdir(join(fixture.root, "secrets"), { recursive: true });
    await writeFile(join(fixture.root, "secrets", "foo.txt"), "not secret\n");

    await expect(reader.read({ path: "secrets/foo.txt" })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("reads public env templates with placeholder-safe content", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    const safeContent = [
      "GPT_REPO_CONFIG=./config.local.json",
      "PORT=8787",
      "CONTROL_PLANE_API_KEY=",
      "TUNNEL_CLIENT_BIN=/path/to/tunnel-client",
      ""
    ].join("\n");

    for (const path of [".env.example", ".env.sample", ".env.template", "example.env"]) {
      await writeFile(join(fixture.root, path), safeContent);
      const result = await reader.read({ path, override_default_excludes: true });
      expect(result.path).toBe(path);
      expect(result.text).toContain("GPT_REPO_CONFIG=./config.local.json");
      expect(result.text).toContain("CONTROL_PLANE_API_KEY=");
    }
  });

  test("scans an entire public env template before returning its first page", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root), 64);
    const unsafeValue = "sk-" + "realSecretValue123456789";
    const content = `${"SAFE=value\n".repeat(100)}OPENAI_API_KEY=${unsafeValue}\n`;
    await writeFile(join(fixture.root, ".env.example"), content);

    await expect(reader.read({ path: ".env.example", override_default_excludes: true })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("rejects public env templates that are too large to scan safely", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root), 64, 64);
    await writeFile(join(fixture.root, ".env.example"), "SAFE=value\n".repeat(100));

    await expect(reader.read({ path: ".env.example", override_default_excludes: true })).rejects.toMatchObject({
      code: "SIZE_LIMIT_EXCEEDED"
    });
  });

  test("still blocks real env files and arbitrary env suffixes", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    await writeFile(join(fixture.root, ".env.local"), "PORT=8787\n");
    await writeFile(join(fixture.root, ".env.production"), "PORT=8787\n");
    await writeFile(join(fixture.root, ".env.anything"), "PORT=8787\n");

    for (const path of [".env", ".env.local", ".env.production", ".env.anything"]) {
      await expect(reader.read({ path, override_default_excludes: true })).rejects.toMatchObject({
        code: "SECRET_CANDIDATE_BLOCKED"
      });
    }
  });

  test("blocks binary files", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: "binary.bin" })).rejects.toMatchObject({
      code: "BINARY_FILE_REJECTED"
    });
  });

  test("blocks binary content that appears after the classifier prefix", async () => {
    const fixture = await createRepoFixture();
    const lateBinary = Buffer.concat([Buffer.from("a".repeat(5_000)), Buffer.from([0]), Buffer.from("tail")]);
    await writeFile(join(fixture.root, "docs", "late-binary.txt"), lateBinary);
    const reader = new FileReader(new PathSandbox(fixture.root), 8_000);

    await expect(reader.read({ path: "docs/late-binary.txt" })).rejects.toMatchObject({
      code: "BINARY_FILE_REJECTED"
    });
  });

  test("blocks invalid UTF-8 without requiring a NUL byte", async () => {
    const fixture = await createRepoFixture();
    const invalidUtf8 = Buffer.concat([Buffer.from("a".repeat(5_000)), Buffer.from([0xc3, 0x28])]);
    await writeFile(join(fixture.root, "docs", "invalid-utf8.txt"), invalidUtf8);
    const reader = new FileReader(new PathSandbox(fixture.root), 8_000);

    await expect(reader.read({ path: "docs/invalid-utf8.txt" })).rejects.toMatchObject({
      code: "BINARY_FILE_REJECTED"
    });
  });

  test("allows generated files only with an explicit override warning", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: "dist/bundle.js" })).rejects.toMatchObject({
      code: "DEFAULT_EXCLUDE_BLOCKED"
    });

    const result = await reader.read({ path: "dist/bundle.js", override_default_excludes: true });
    expect(result.warnings).toEqual(["Read default-excluded path with override: dist/bundle.js"]);
  });

  test("treats max_bytes as a response limit instead of a file-size limit", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    const result = await reader.read({ path: "src/app.ts", max_bytes: 10 });
    expect(result.returned_bytes).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
    expect(result.next_cursor).toEqual(expect.any(String));
  });
});
