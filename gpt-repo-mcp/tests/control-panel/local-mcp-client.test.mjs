import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import http from "node:http";
import { afterEach, test } from "node:test";
import { LocalMcpClient, parseMcpMessages } from "../../../scripts/control-panel/local-mcp-client.mjs";

const openServers = new Set();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
  openServers.clear();
});

function sendSse(res, payload, sessionId) {
  const headers = { "content-type": "text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  res.writeHead(200, headers);
  res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function createFixtureServer(handler) {
  const server = http.createServer(handler);
  openServers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("parseMcpMessages handles JSON and SSE response bodies", () => {
  assert.deepEqual(parseMcpMessages("application/json", '{"jsonrpc":"2.0","id":1,"result":{}}'), [
    { jsonrpc: "2.0", id: 1, result: {} }
  ]);
  assert.deepEqual(parseMcpMessages("text/event-stream", 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n'), [
    { jsonrpc: "2.0", id: 2, result: { ok: true } }
  ]);
});

test("LocalMcpClient initializes a session, lists tools, and calls a tool", async () => {
  const requests = [];
  const endpoint = await createFixtureServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({
      body,
      sessionId: req.headers["mcp-session-id"],
      protocolVersion: req.headers["mcp-protocol-version"]
    });

    if (body.method === "initialize") {
      sendSse(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" }
        }
      }, "fixture-session");
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (body.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }));
      return;
    }
    sendSse(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: body.params.arguments.text }] } });
  });

  const client = new LocalMcpClient({ endpoint });
  assert.deepEqual(await client.initialize(), {
    connected: true,
    protocolVersion: "2025-11-25",
    serverInfo: { name: "fixture", version: "1.0.0" },
    capabilities: { tools: {} }
  });
  assert.equal((await client.listTools()).tools[0].name, "echo");
  assert.equal((await client.callTool("echo", { text: "hello" })).content[0].text, "hello");
  assert.deepEqual(requests.map((request) => request.body.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call"
  ]);
  assert.equal(requests[0].sessionId, undefined);
  assert.equal(requests[0].protocolVersion, undefined);
  assert(requests.slice(1).every((request) => request.sessionId === "fixture-session"));
  assert(requests.slice(1).every((request) => request.protocolVersion === "2025-11-25"));
});

test("LocalMcpClient rejects unsafe endpoints and malformed tool calls before fetching", async () => {
  assert.throws(() => new LocalMcpClient({ endpoint: "https://example.com/mcp" }), /127\.0\.0\.1/);
  assert.throws(() => new LocalMcpClient({ endpoint: "http://127.0.0.1:123@evil.test/mcp" }), /127\.0\.0\.1/);

  let fetchCount = 0;
  const client = new LocalMcpClient({
    endpoint: "http://127.0.0.1:8787/mcp",
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("should not fetch");
    }
  });
  await assert.rejects(client.callTool("bad tool name", {}), /Tool name/);
  await assert.rejects(client.callTool("safe_name", []), /JSON object/);
  assert.equal(fetchCount, 0);
});

test("LocalMcpClient surfaces JSON-RPC error messages", async () => {
  const endpoint = await createFixtureServer(async (req, res) => {
    const body = await readJsonBody(req);
    if (body.method === "initialize") {
      sendSse(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" }
        }
      }, "fixture-session");
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    sendSse(res, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Invalid arguments" } });
  });

  const client = new LocalMcpClient({ endpoint });
  await assert.rejects(client.callTool("echo", {}), /Invalid arguments/);
});

test("LocalMcpClient timeout covers a response body that never completes", async () => {
  const endpoint = await createFixtureServer(async (req, res) => {
    await readJsonBody(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "mcp-session-id": "fixture-session"
    });
    res.write("event: message\ndata: ");
  });

  const client = new LocalMcpClient({ endpoint, timeoutMs: 50 });
  await assert.rejects(client.initialize(), /timed out after 50 ms/);
  assert.equal(client.connectionInfo.connected, false);
});

test("LocalMcpClient deletes a server session when initialized notification fails", async () => {
  let deletedSessionId = null;
  const endpoint = await createFixtureServer(async (req, res) => {
    if (req.method === "DELETE") {
      deletedSessionId = req.headers["mcp-session-id"];
      res.writeHead(204).end();
      return;
    }

    const body = await readJsonBody(req);
    if (body.method === "initialize") {
      sendSse(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" }
        }
      }, "failed-session");
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "notification failed" }));
  });

  const client = new LocalMcpClient({ endpoint });
  await assert.rejects(client.initialize(), /HTTP 500/);
  assert.equal(deletedSessionId, "failed-session");
  assert.equal(client.connectionInfo.connected, false);
});
