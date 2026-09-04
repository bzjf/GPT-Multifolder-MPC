import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseSseMessages(text) {
  const messages = [];
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data !== "[DONE]") messages.push(parseJson(data, "MCP SSE event"));
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "") {
      flush();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  flush();
  return messages;
}

export function parseMcpMessages(contentType, text) {
  if (!text.trim()) return [];
  if (contentType.toLowerCase().includes("text/event-stream")) return parseSseMessages(text);
  const value = parseJson(text, "MCP endpoint");
  return Array.isArray(value) ? value : [value];
}

function errorMessageFromMessages(messages, fallback) {
  const protocolError = messages.find((message) => isRecord(message?.error))?.error;
  if (typeof protocolError?.message === "string") return protocolError.message;
  return fallback;
}

async function readResponseText(response) {
  const advertisedBytes = Number(response.headers.get("content-length") ?? 0);
  if (advertisedBytes > MAX_RESPONSE_BYTES) throw new Error("MCP response exceeds 2 MiB.");

  if (!response.body) return "";
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_RESPONSE_BYTES) throw new Error("MCP response exceeds 2 MiB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class LocalMcpClient {
  constructor({ endpoint, fetchImpl = globalThis.fetch, protocolVersion = DEFAULT_PROTOCOL_VERSION, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    let endpointUrl;
    try {
      endpointUrl = new globalThis.URL(endpoint);
    } catch {
      throw new Error("Local MCP endpoint must be a valid URL.");
    }
    if (
      endpointUrl.protocol !== "http:" ||
      endpointUrl.hostname !== "127.0.0.1" ||
      !endpointUrl.port ||
      endpointUrl.username ||
      endpointUrl.password
    ) {
      throw new Error("Local MCP endpoint must use http://127.0.0.1 with an explicit port.");
    }
    if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

    this.endpoint = endpointUrl.href;
    this.fetchImpl = fetchImpl;
    this.protocolVersion = protocolVersion;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.negotiatedProtocolVersion = null;
    this.nextRequestId = 1;
    this.initializePromise = null;
  }

  get connectionInfo() {
    return {
      connected: Boolean(this.sessionId),
      protocolVersion: this.negotiatedProtocolVersion,
      serverInfo: this.serverInfo,
      capabilities: this.serverCapabilities
    };
  }

  async initialize({ force = false } = {}) {
    if (force) {
      await this.close().catch(() => {});
    } else if (this.sessionId) {
      return this.connectionInfo;
    }

    if (!this.initializePromise) {
      this.initializePromise = this.#initializeSession().finally(() => {
        this.initializePromise = null;
      });
    }
    return this.initializePromise;
  }

  async #initializeSession() {
    const id = this.nextRequestId++;
    const response = await this.#post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: "gpt-repo-control-panel", version: "1.0.0" }
      }
    }, { expectedId: id, includeSession: false });

    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP initialize response did not include mcp-session-id.");

    const result = response.message.result;
    this.sessionId = sessionId;
    this.negotiatedProtocolVersion = result?.protocolVersion ?? this.protocolVersion;
    this.serverInfo = result?.serverInfo ?? null;
    this.serverCapabilities = result?.capabilities ?? null;
    try {
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, {
        allowEmpty: true,
        includeSession: true
      });
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }

    return this.connectionInfo;
  }

  async listTools() {
    await this.initialize();
    const result = await this.#request("tools/list", {});
    if (!Array.isArray(result?.tools)) throw new Error("MCP tools/list response did not contain a tools array.");
    return result;
  }

  async callTool(name, args = {}) {
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      throw new Error("Tool name must contain 1-128 letters, digits, underscores, dots, or hyphens.");
    }
    if (!isRecord(args)) throw new Error("Tool arguments must be a JSON object.");

    await this.initialize();
    return this.#request("tools/call", { name, arguments: args });
  }

  async #request(method, params) {
    const id = this.nextRequestId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params }, {
      expectedId: id,
      includeSession: true
    });
    return response.message.result;
  }

  async #post(payload, { allowEmpty = false, expectedId, includeSession }) {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    };
    if (includeSession) {
      if (!this.sessionId) throw new Error("MCP session is not initialized.");
      headers["mcp-session-id"] = this.sessionId;
      headers["mcp-protocol-version"] = this.negotiatedProtocolVersion ?? this.protocolVersion;
    }

    const controller = new globalThis.AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let text;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      text = await readResponseText(response);
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        await response?.body?.cancel().catch(() => {});
        throw new Error(`MCP request timed out after ${this.timeoutMs} ms.`);
      }
      if (!response) {
        throw new Error(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    let messages = [];
    try {
      messages = parseMcpMessages(response.headers.get("content-type") ?? "", text);
    } catch (error) {
      if (response.ok) throw error;
    }
    if (!response.ok) {
      const detail = text.trim().slice(0, 300);
      const fallback = "MCP endpoint returned HTTP " + response.status + (detail ? ": " + detail : ".");
      throw new Error(errorMessageFromMessages(messages, fallback));
    }
    if (allowEmpty && messages.length === 0) return { headers: response.headers, message: null };

    const message = expectedId === undefined
      ? messages[0]
      : messages.find((candidate) => candidate?.id === expectedId);
    if (!message) throw new Error("MCP endpoint returned no matching JSON-RPC response.");
    if (isRecord(message.error)) throw new Error(errorMessageFromMessages([message], "MCP request failed."));
    if (!("result" in message)) throw new Error("MCP JSON-RPC response did not contain a result.");
    return { headers: response.headers, message };
  }

  async close() {
    const sessionId = this.sessionId;
    const protocolVersion = this.negotiatedProtocolVersion ?? this.protocolVersion;
    this.#clearSession();
    if (!sessionId) return;

    const controller = new globalThis.AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId,
          "mcp-protocol-version": protocolVersion
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  #clearSession() {
    this.sessionId = null;
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.negotiatedProtocolVersion = null;
  }
}
