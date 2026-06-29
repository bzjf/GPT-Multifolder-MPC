import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_CONFIG_PATH = "./config.local.json";
const DEFAULT_PORT = "8787";
const DEFAULT_PROFILE = "gpt-repo-local";
const children = [];
let shuttingDown = false;

await loadDotEnv(".env");
await ensureConfigExists(envValue("GPT_REPO_CONFIG", "REPO_READER_CONFIG", DEFAULT_CONFIG_PATH));
ensureRequiredEnv("CONTROL_PLANE_API_KEY");
const tunnelClientBin = envValue("TUNNEL_CLIENT_BIN", undefined, "tunnel-client");
const tunnelClientProfile = envValue("TUNNEL_CLIENT_PROFILE", undefined, DEFAULT_PROFILE);

startProcesses();

async function loadDotEnv(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const [key, ...valueParts] = trimmed.split("=");
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = unquoteEnvValue(valueParts.join("="));
  }
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function ensureConfigExists(configPath) {
  try {
    await access(configPath, constants.F_OK);
  } catch {
    globalThis.console.error(`Missing ${configPath}. Run: cp config.example.json ${configPath}`);
    process.exit(1);
  }
}

function ensureRequiredEnv(name) {
  if (!process.env[name]) {
    globalThis.console.error(`Missing ${name}. Add it to .env or export it before running npm run connect:secure.`);
    process.exit(1);
  }
}

function envValue(primaryName, legacyName, fallback) {
  const primary = process.env[primaryName];
  if (primary && primary.trim() !== "") {
    return primary;
  }
  const legacy = legacyName ? process.env[legacyName] : undefined;
  if (legacy && legacy.trim() !== "") {
    return legacy;
  }
  return fallback;
}

function prefixOutput(stream, label) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`[${label}] ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      process.stdout.write(`[${label}] ${buffer}\n`);
    }
  });
}

function startProcesses() {
  const configPath = envValue("GPT_REPO_CONFIG", "REPO_READER_CONFIG", DEFAULT_CONFIG_PATH);
  const port = envValue("PORT", undefined, DEFAULT_PORT);
  const logFormat = envValue("GPT_REPO_LOG_FORMAT", "REPO_READER_LOG_FORMAT", "pretty");

  globalThis.console.log("Starting GPT Repo MCP and OpenAI Secure MCP Tunnel.");
  globalThis.console.log(`Running: tunnel-client run --profile ${tunnelClientProfile}`);
  globalThis.console.log("Open ChatGPT connector settings, choose Tunnel, and select the configured tunnel while this process is running.");
  globalThis.console.log(`Tunnel profile: ${tunnelClientProfile}`);
  globalThis.console.log(`Local MCP URL: http://127.0.0.1:${port}/mcp`);

  const mcp = spawn("npm", ["run", "dev"], {
    env: {
      ...process.env,
      GPT_REPO_CONFIG: configPath,
      REPO_READER_CONFIG: configPath,
      PORT: port,
      GPT_REPO_LOG_FORMAT: logFormat,
      REPO_READER_LOG_FORMAT: logFormat
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(mcp);
  prefixOutput(mcp.stdout, "mcp");
  prefixOutput(mcp.stderr, "mcp");
  mcp.once("exit", onChildExit("mcp"));

  const tunnel = spawn(tunnelClientBin, ["run", "--profile", tunnelClientProfile], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(tunnel);
  prefixOutput(tunnel.stdout, "tunnel");
  prefixOutput(tunnel.stderr, "tunnel");
  tunnel.once("exit", onChildExit("tunnel"));
  tunnel.once("error", (error) => {
    globalThis.console.error(`[tunnel] failed to start: ${error.message}`);
    terminateAndExit(1);
  });
}

function onChildExit(name) {
  return (code, signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    globalThis.console.error(`[${name}] exited (code=${code ?? "null"}, signal=${signal ?? "null"}). Stopping other process.`);
    terminateChildren("SIGTERM");
    globalThis.setTimeout(() => terminateChildren("SIGKILL"), 1500);
    process.exit(code ?? 1);
  };
}

function terminateChildren(signal = "SIGTERM") {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

function terminateAndExit(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  terminateChildren("SIGTERM");
  globalThis.setTimeout(() => terminateChildren("SIGKILL"), 1500);
  globalThis.setTimeout(() => process.exit(code), 1700);
}

function handleShutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  globalThis.console.log(`Received ${signal}. Shutting down MCP server and secure tunnel.`);
  terminateChildren("SIGTERM");
  globalThis.setTimeout(() => terminateChildren("SIGKILL"), 1500);
  globalThis.setTimeout(() => process.exit(0), 1700);
}

function isNotFoundError(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
  );
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
