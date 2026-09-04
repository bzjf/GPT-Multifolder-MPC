import { describe, expect, test, vi } from "vitest";
import { audit } from "../../src/runtime/telemetry.js";

describe("structured audit details", () => {
  test("emits bounded read and line-operation metadata", () => {
    const originalFormat = process.env.GPT_REPO_LOG_FORMAT;
    process.env.GPT_REPO_LOG_FORMAT = "json";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      audit({
        tool: "repo_fetch_file",
        repo_id: "example",
        details: {
          selector_mode: "lines",
          read_mode: "lines",
          requested_start_line: 10,
          requested_end_line: 20,
          cursor_used: false,
          operation_types: Array.from({ length: 80 }, (_, index) => `replace_lines_${index}`)
        }
      });

      const line = String(error.mock.calls[0]?.[0] ?? "");
      const parsed = JSON.parse(line) as {
        details?: Record<string, string | number | boolean | string[]>;
      };
      expect(parsed.details).toMatchObject({
        selector_mode: "lines",
        read_mode: "lines",
        requested_start_line: 10,
        requested_end_line: 20,
        cursor_used: false
      });
      expect(parsed.details?.operation_types).toHaveLength(64);
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
