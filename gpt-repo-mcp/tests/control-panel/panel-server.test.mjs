import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import http from "node:http";
import test from "node:test";
import { createPanelServer, httpError } from "../../../scripts/control-panel/panel-server.mjs";

function createActions(overrides = {}) {
  return {
    getState: () => ({ ok: true }),
    startFunnel: () => {},
    stopFunnel: () => {},
    getPorts: (query) => ({ query }),
    getNodePorts: () => ({ ports: [] }),
    selectFolder: () => ({ cancelled: true }),
    initializeMcp: async (id) => ({ id, initialized: true }),
    listMcpTools: async (id) => ({ id, tools: [] }),
    callMcpTool: async (id, input) => ({ id, input }),
    terminateNodeProcess: (input) => ({ input }),
    terminateProcess: (input) => ({ input }),
    addInstance: (input) => ({ input }),
    startInstance: async (id) => ({ id, running: true }),
    stopInstance: (id) => ({ id, running: false }),
    removeInstance: (id) => ({ id, removed: true }),
    ...overrides
  };
}

async function withServer(actions, run) {
  const server = createPanelServer({ html: "<!doctype html><title>panel</title>", actions });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, { path = "/", method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function jsonHeaders(port, extra = {}) {
  return {
    host: `127.0.0.1:${port}`,
    "content-type": "application/json",
    ...extra
  };
}

test("PanelServer serves the page and state with security headers", async () => {
  await withServer(createActions(), async (port) => {
    const page = await request(port);
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>panel<\/title>/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);

    const state = await request(port, { path: "/api/state" });
    assert.equal(state.status, 200);
    assert.deepEqual(JSON.parse(state.text), { ok: true });
  });
});

test("PanelServer routes MCP tool calls through the actions interface", async () => {
  let received;
  const actions = createActions({
    callMcpTool: async (id, input) => {
      received = { id, input };
      return { accepted: true };
    }
  });

  await withServer(actions, async (port) => {
    const response = await request(port, {
      path: "/api/mcp-test/mcp-123/call",
      method: "POST",
      headers: jsonHeaders(port),
      body: JSON.stringify({ toolName: "repo_list_roots", arguments: {} })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { accepted: true });
    assert.deepEqual(received, {
      id: "mcp-123",
      input: { toolName: "repo_list_roots", arguments: {} }
    });
  });
});

test("PanelServer rejects untrusted and malformed mutation requests", async () => {
  await withServer(createActions(), async (port) => {
    const badHost = await request(port, { headers: { host: "evil.example" } });
    assert.equal(badHost.status, 421);

    const badOrigin = await request(port, {
      path: "/api/instances",
      method: "POST",
      headers: jsonHeaders(port, { origin: "https://evil.example" }),
      body: "{}"
    });
    assert.equal(badOrigin.status, 403);

    const badType = await request(port, {
      path: "/api/instances",
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "text/plain" },
      body: "{}"
    });
    assert.equal(badType.status, 415);

    const badJson = await request(port, {
      path: "/api/instances",
      method: "POST",
      headers: jsonHeaders(port),
      body: "not-json"
    });
    assert.equal(badJson.status, 400);
  });
});

test("PanelServer preserves structured port-conflict errors", async () => {
  const portConflict = { port: 8788, occupants: [{ pid: 42 }] };
  const actions = createActions({
    startInstance: async () => {
      throw httpError(409, "Port is occupied.", { portConflict });
    }
  });

  await withServer(actions, async (port) => {
    const response = await request(port, {
      path: "/api/instances/mcp-123/start",
      method: "POST",
      headers: jsonHeaders(port),
      body: "{}"
    });
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.text), { error: "Port is occupied.", portConflict });
  });
});
