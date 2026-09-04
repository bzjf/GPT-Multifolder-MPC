import assert from "node:assert/strict";
import test from "node:test";
import { waitForMcpReady } from "../../../scripts/control-panel/mcp-readiness.mjs";

test("waitForMcpReady retries until the health contract succeeds", async () => {
  let attempts = 0;
  const result = await waitForMcpReady({
    port: 8788,
    isProcessRunning: () => true,
    timeoutMs: 200,
    retryIntervalMs: 1,
    fetchImpl: async (url) => {
      attempts += 1;
      assert.equal(url, "http://127.0.0.1:8788/health");
      if (attempts < 3) return new globalThis.Response("starting", { status: 503 });
      return globalThis.Response.json({ ok: true, name: "gpt-repo-mcp" });
    }
  });

  assert.equal(attempts, 3);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.health, { ok: true, name: "gpt-repo-mcp" });
});

test("waitForMcpReady fails immediately after process exit", async () => {
  let fetchCount = 0;
  await assert.rejects(waitForMcpReady({
    port: 8788,
    isProcessRunning: () => false,
    fetchImpl: async () => {
      fetchCount += 1;
      return globalThis.Response.json({ ok: true, name: "gpt-repo-mcp" });
    }
  }), /process exited before/);
  assert.equal(fetchCount, 0);
});

test("waitForMcpReady reports a bounded timeout with the last health error", async () => {
  await assert.rejects(waitForMcpReady({
    port: 8788,
    isProcessRunning: () => true,
    timeoutMs: 20,
    retryIntervalMs: 2,
    fetchImpl: async () => new globalThis.Response("starting", { status: 503 })
  }), /not ready within 20 ms.*HTTP 503/);
});
