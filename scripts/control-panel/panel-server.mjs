import http from "node:http";

const MAX_REQUEST_BYTES = 256 * 1024;

export function httpError(status, message, details = {}) {
  return Object.assign(new Error(message), { status, ...details });
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

async function readBody(req) {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    throw httpError(413, "Request body exceeds 256 KiB.");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw httpError(413, "Request body exceeds 256 KiB.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function trustedHosts(req) {
  const localPort = Number(req.socket.localPort);
  return new Set([
    `127.0.0.1:${localPort}`,
    `localhost:${localPort}`,
    `[::1]:${localPort}`
  ]);
}

function assertTrustedRequest(req) {
  const remoteAddress = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1") {
    throw httpError(403, "Control panel only accepts loopback clients.");
  }

  const expectedHosts = trustedHosts(req);
  const requestHost = String(req.headers.host ?? "").toLowerCase();
  if (!expectedHosts.has(requestHost)) throw httpError(421, "Untrusted Host header.");

  const fetchSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (fetchSite === "cross-site" && req.method !== "GET" && req.method !== "HEAD") {
    throw httpError(403, "Cross-site mutation requests are not allowed.");
  }

  const origin = req.headers.origin;
  if (typeof origin === "string") {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw httpError(403, "Invalid Origin header.");
    }
    if (parsedOrigin.protocol !== "http:" || !expectedHosts.has(parsedOrigin.host.toLowerCase())) {
      throw httpError(403, "Cross-origin requests are not allowed.");
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      throw httpError(415, "Mutation requests require application/json.");
    }
  }
}

function setSecurityHeaders(res) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
}

async function routeRequest(req, res, url, html, actions) {
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, actions.getState());
  }
  if (req.method === "POST" && url.pathname === "/api/funnel/start") {
    actions.startFunnel();
    return sendJson(res, actions.getState());
  }
  if (req.method === "POST" && url.pathname === "/api/funnel/stop") {
    actions.stopFunnel();
    return sendJson(res, actions.getState());
  }
  if (req.method === "GET" && url.pathname === "/api/ports") {
    return sendJson(res, actions.getPorts(url.searchParams.get("ports")));
  }
  if (req.method === "GET" && url.pathname === "/api/node-ports") {
    return sendJson(res, actions.getNodePorts());
  }
  if (req.method === "POST" && url.pathname === "/api/select-folder") {
    return sendJson(res, actions.selectFolder());
  }

  const mcpTestMatch = url.pathname.match(/^\/api\/mcp-test\/([^/]+)\/(initialize|tools|call)$/);
  if (mcpTestMatch && req.method === "POST") {
    const id = decodeURIComponent(mcpTestMatch[1]);
    if (mcpTestMatch[2] === "initialize") return sendJson(res, await actions.initializeMcp(id));
    if (mcpTestMatch[2] === "tools") return sendJson(res, await actions.listMcpTools(id));
    return sendJson(res, await actions.callMcpTool(id, await readBody(req)));
  }

  const nodePortKillMatch = url.pathname.match(/^\/api\/node-ports\/(\d+)\/kill$/);
  if (nodePortKillMatch && req.method === "POST") {
    return sendJson(res, actions.terminateNodeProcess({
      ...(await readBody(req)),
      pid: nodePortKillMatch[1]
    }));
  }

  const portKillMatch = url.pathname.match(/^\/api\/ports\/(\d+)\/kill$/);
  if (portKillMatch && req.method === "POST") {
    return sendJson(res, actions.terminateProcess({
      ...(await readBody(req)),
      pid: portKillMatch[1]
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/instances") {
    return sendJson(res, actions.addInstance(await readBody(req)));
  }

  const instanceMatch = url.pathname.match(/^\/api\/instances\/([^/]+)(?:\/(start|stop))?$/);
  if (instanceMatch && req.method === "POST" && instanceMatch[2] === "start") {
    return sendJson(res, await actions.startInstance(instanceMatch[1]));
  }
  if (instanceMatch && req.method === "POST" && instanceMatch[2] === "stop") {
    return sendJson(res, actions.stopInstance(instanceMatch[1]));
  }
  if (instanceMatch && req.method === "DELETE") {
    return sendJson(res, actions.removeInstance(instanceMatch[1]));
  }

  sendJson(res, { error: "Not found" }, 404);
}

export function createPanelServer({ html, actions }) {
  if (typeof html !== "string") throw new Error("Panel HTML is required.");
  if (!actions || typeof actions !== "object") throw new Error("Panel actions are required.");

  return http.createServer(async (req, res) => {
    try {
      setSecurityHeaders(res);
      assertTrustedRequest(req);
      const localPort = Number(req.socket.localPort);
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${localPort}`);
      await routeRequest(req, res, url, html, actions);
    } catch (error) {
      const status = Number(error?.status ?? 500);
      const body = { error: error instanceof Error ? error.message : String(error) };
      if (error?.portConflict) body.portConflict = error.portConflict;
      sendJson(res, body, status >= 400 && status <= 599 ? status : 500);
    }
  });
}
