import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("documentation image assets", () => {
  test.each([
    "chatgpt-server-url.png",
    "chatgpt-tunnel-id.png"
  ])("%s is a real PNG rather than a text placeholder", async (fileName) => {
    const content = await readFile(join(process.cwd(), "docs", "assets", fileName));

    expect(content.byteLength).toBeGreaterThan(PNG_SIGNATURE.byteLength);
    expect(content.subarray(0, PNG_SIGNATURE.byteLength)).toEqual(PNG_SIGNATURE);
  });
});
