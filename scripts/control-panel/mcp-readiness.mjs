import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

async function checkHealth(url, fetchImpl, timeoutMs) {
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true || body?.name !== "gpt-repo-mcp") {
      throw new Error("health endpoint returned an unexpected payload");
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      await response?.body?.cancel().catch(() => {});
      throw new Error(`health request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForMcpReady({
  port,
  isProcessRunning,
  timeoutMs = 30_000,
  retryIntervalMs = 250,
  requestTimeoutMs = 2_000,
  fetchImpl = globalThis.fetch
}) {
  if (!validPort(port)) throw new Error(`Invalid MCP health port: ${port}`);
  if (typeof isProcessRunning !== "function") throw new Error("isProcessRunning callback is required.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, Number(timeoutMs));
  const healthUrl = `http://127.0.0.1:${Number(port)}/health`;
  let attempts = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    if (!isProcessRunning()) {
      throw new Error("MCP process exited before its health endpoint became ready.");
    }

    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      const health = await checkHealth(healthUrl, fetchImpl, Math.min(requestTimeoutMs, remainingMs));
      return { health, healthUrl, attempts, readyAt: new Date().toISOString() };
    } catch (error) {
      lastError = error;
    }

    const waitMs = Math.min(Math.max(1, retryIntervalMs), Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await delay(waitMs);
  }

  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`MCP health endpoint was not ready within ${timeoutMs} ms.${detail}`);
}
