#!/usr/bin/env node
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptDir);
const mainConfigPath = path.join(rootDir, "gpt-repo-mcp.config.json");
const runtimeRoot = path.join(rootDir, ".runtime", "control-panel");
const statePath = path.join(runtimeRoot, "state.json");
const panelPort = Number(process.env.GPT_REPO_PANEL_PORT ?? 8790);
let proxyPort = Number(process.env.GPT_REPO_PROXY_PORT ?? 8800);
const proxyHost = "127.0.0.1";
let proxyPublicBaseUrl = localProxyBaseUrl();
let proxyFunnelStarted = false;
const host = "127.0.0.1";
const runtime = new Map();
const nodePortsCacheMs = 3000;
let nodePortsCache = { at: 0, value: null };

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function randomText(length = 32) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars[randomInt(chars.length)];
  return out;
}

function resolveConfigPath(value, fallback = ".") {
  const raw = String(value ?? fallback).trim() || fallback;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(rootDir, raw);
}

function normalizeRepoPath(repoPath) {
  return resolveConfigPath(repoPath).replace(/[\\/]+$/, "").toLowerCase();
}

function pathKey(repoPath) {
  return createHash("sha256").update(normalizeRepoPath(repoPath)).digest("hex").slice(0, 16);
}

function loadMainConfig() {
  if (!existsSync(mainConfigPath)) throw new Error(`Missing config: ${mainConfigPath}`);
  const main = readJson(mainConfigPath, {});
  main.installRoot = resolveConfigPath(main.installRoot ?? ".");
  main.projectDirName = String(main.projectDirName ?? "gpt-repo-mcp");
  main.repoPath = resolveConfigPath(main.repoPath ?? ".");
  return main;
}

function loadState() {
  const main = loadMainConfig();
  const basePort = Number(main.localPort ?? 8787);
  return readJson(statePath, { nextPort: basePort + 2, instances: [] });
}

function saveState(state) {
  writeJson(statePath, state);
}

function instanceDir(id) {
  return path.join(runtimeRoot, "instances", id);
}

function stablePublicCodeFor(repoPath, length) {
  const normalized = normalizeRepoPath(repoPath);
  const digest = createHash("sha256").update(`public:${normalized}`).digest("hex");
  return digest.slice(0, Math.max(16, Number(length) || 32));
}

function publicCodeFor(repoPath, length) {
  const key = pathKey(repoPath);
  const filePath = path.join(runtimeRoot, `public-path-code-${key}.txt`);
  if (existsSync(filePath)) return readFileSync(filePath, "utf8").trim();
  const code = stablePublicCodeFor(repoPath, length);
  writeFileSync(filePath, `${code}\n`, "utf8");
  return code;
}

function pickPort(state) {
  const used = new Set(state.instances.map((item) => Number(item.localPort)));
  let port = Number(state.nextPort ?? 8788);
  while (used.has(port)) port += 1;
  state.nextPort = port + 1;
  return port;
}

function instanceView(item) {
  const live = runtime.get(item.id);
  return {
    ...item,
    running: Boolean(live?.child && !live.child.killed && !live.exited),
    url: live?.url ?? null,
    localUrl: live?.localUrl ?? null,
    mcp_code: live?.runtimeCode ?? null,
    logPath: live?.logPath ?? path.join(instanceDir(item.id), "server.log"),
    lastError: live?.lastError ?? null
  };
}

function rememberInstanceError(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const previous = runtime.get(id) ?? {};
  runtime.set(id, { ...previous, lastError: message });
  return message;
}
function listView() {
  const state = loadState();
  return {
    panel: { host, port: panelPort, statePath },
    proxy: { host: proxyHost, port: proxyPort, publicBaseUrl: proxyPublicBaseUrl, funnelStarted: proxyFunnelStarted },
    instances: state.instances.map(instanceView)
  };
}

function localProxyBaseUrl() {
  return `http://localhost:${proxyPort}`;
}

function listenOnAvailablePort(serverToListen, initialPort, bindHost, label, maxRetries = 25) {
  return new Promise((resolve, reject) => {
    let port = Number(initialPort);
    let retries = 0;

    const tryListen = () => {
      const onError = (error) => {
        serverToListen.off("listening", onListening);
        if (error?.code === "EADDRINUSE") {
          if (retries < maxRetries) {
            const nextPort = port + 1;
            console.warn(`${label} port ${port} is already in use; trying ${nextPort}.`);
            port = nextPort;
            retries += 1;
            tryListen();
            return;
          }
          reject(new Error(`${label} port ${port} is already in use at ${bindHost}:${port}. Stop the existing process or set another port explicitly.`));
          return;
        }
        reject(error);
      };
      const onListening = () => {
        serverToListen.off("error", onError);
        resolve(port);
      };

      serverToListen.once("error", onError);
      serverToListen.once("listening", onListening);
      try {
        serverToListen.listen(port, bindHost);
      } catch (error) {
        serverToListen.off("error", onError);
        serverToListen.off("listening", onListening);
        reject(error);
      }
    };

    tryListen();
  });
}

function assertPortAvailable(port, bindHost, label) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        reject(new Error(`${label} port ${port} is already in use on ${bindHost}. Stop the existing process or choose another local port.`));
        return;
      }
      reject(error);
    });
    probe.once("listening", () => {
      probe.close(() => resolve());
    });
    probe.listen(Number(port), bindHost);
  });
}

function openPanelInBrowser(url) {
  if (process.env.GPT_REPO_PANEL_OPEN !== "1") return;
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch (error) {
    console.warn(`Failed to open browser: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  return result.stdout;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function isValidPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parsePortFilter(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const ports = new Set();
  for (const part of text.split(/[,\s]+/)) {
    if (!part) continue;
    const range = part.match(/^(\d{1,5})-(\d{1,5})$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!isValidPort(start) || !isValidPort(end) || end < start) throw new Error(`Invalid port range: ${part}`);
      if (end - start > 2000) throw new Error(`Port range is too large: ${part}`);
      for (let port = start; port <= end; port += 1) ports.add(port);
      continue;
    }
    const port = Number(part);
    if (!isValidPort(port)) throw new Error(`Invalid port: ${part}`);
    ports.add(port);
  }
  return ports;
}

function portFromAddress(address) {
  const text = String(address ?? "").trim();
  const bracketMatch = text.match(/\]:(\d+)$/);
  if (bracketMatch) return Number(bracketMatch[1]);
  const suffixMatch = text.match(/:(\d+)$/);
  return suffixMatch ? Number(suffixMatch[1]) : null;
}

function processNameMap() {
  const names = new Map();
  if (process.platform === "win32") {
    try {
      const raw = runSync("tasklist", ["/FO", "CSV", "/NH"]);
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const cells = parseCsvLine(line);
        const pid = Number(cells[1]);
        if (Number.isInteger(pid)) names.set(pid, cells[0]);
      }
    } catch {}
    return names;
  }
  try {
    const raw = runSync("ps", ["-axo", "pid=,comm="]);
    for (const line of raw.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match) names.set(Number(match[1]), match[2]);
    }
  } catch {}
  return names;
}

function listWindowsOccupiedPorts(portSet, names) {
  const raw = runSync("netstat", ["-ano"]);
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const protocol = parts[0];
    if (protocol !== "TCP" && protocol !== "UDP") continue;
    if (parts.length < 4) continue;

    const localAddress = parts[1];
    const port = portFromAddress(localAddress);
    if (!isValidPort(port) || (portSet && !portSet.has(port))) continue;

    const state = protocol === "TCP" ? parts[3] : "UDP";
    const pidText = protocol === "TCP" ? parts[4] : parts[3];
    const pid = Number(pidText);
    rows.push({
      protocol,
      localAddress,
      port,
      state: state || protocol,
      pid: Number.isInteger(pid) ? pid : null,
      processName: names.get(pid) ?? null
    });
  }
  return rows;
}

function localSideFromConnectionName(name) {
  return String(name ?? "")
    .replace(/\s+\([^)]+\)$/, "")
    .split("->")[0]
    .trim();
}

function listUnixOccupiedPorts(portSet, names) {
  try {
    const raw = runSync("lsof", ["-nP", "-iTCP", "-iUDP"]);
    const rows = [];
    for (const line of raw.split(/\r?\n/).slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const pid = Number(parts[1]);
      const protocol = parts[7]?.toUpperCase().startsWith("UDP") ? "UDP" : "TCP";
      const name = parts.slice(8).join(" ");
      const localAddress = localSideFromConnectionName(name);
      const port = portFromAddress(localAddress);
      if (!isValidPort(port) || (portSet && !portSet.has(port))) continue;
      const stateMatch = name.match(/\(([^)]+)\)$/);
      rows.push({
        protocol,
        localAddress,
        port,
        state: stateMatch?.[1] ?? protocol,
        pid: Number.isInteger(pid) ? pid : null,
        processName: parts[0] || names.get(pid) || null
      });
    }
    return rows;
  } catch {}

  const raw = runSync("ss", ["-tunap"]);
  const rows = [];
  for (const line of raw.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    const protocol = parts[0]?.toUpperCase();
    if (protocol !== "TCP" && protocol !== "UDP") continue;
    if (parts.length < 5) continue;
    const state = parts[1] || protocol;
    const localAddress = protocol === "UDP" ? parts[4] : parts[4];
    const port = portFromAddress(localAddress);
    if (!isValidPort(port) || (portSet && !portSet.has(port))) continue;
    const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const pid = processMatch ? Number(processMatch[2]) : null;
    rows.push({
      protocol,
      localAddress,
      port,
      state,
      pid: Number.isInteger(pid) ? pid : null,
      processName: processMatch?.[1] ?? (Number.isInteger(pid) ? names.get(pid) : null) ?? null
    });
  }
  return rows;
}

function listOccupiedPorts(portSet) {
  if (!(portSet instanceof Set) || portSet.size === 0) return [];
  const names = processNameMap();
  const rows = process.platform === "win32"
    ? listWindowsOccupiedPorts(portSet, names)
    : listUnixOccupiedPorts(portSet, names);
  const deduped = new Map();
  for (const row of rows) deduped.set(`${row.protocol}:${row.localAddress}:${row.state}:${row.pid ?? ""}`, row);
  return [...deduped.values()].sort((a, b) => a.port - b.port || String(a.protocol).localeCompare(String(b.protocol)) || Number(a.pid ?? 0) - Number(b.pid ?? 0));
}

function suggestedPorts() {
  const ports = new Set([Number(panelPort), Number(proxyPort)]);
  try {
    const state = loadState();
    for (const item of state.instances) if (isValidPort(item.localPort)) ports.add(Number(item.localPort));
  } catch {}
  return [...ports].filter(isValidPort).sort((a, b) => a - b);
}

function portsView(rawPorts) {
  const query = String(rawPorts ?? "").trim();
  const portSet = query ? parsePortFilter(query) : new Set();
  return {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    query,
    suggestedPorts: suggestedPorts(),
    ports: query ? listOccupiedPorts(portSet) : []
  };
}

function isNodeProcessName(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  return normalized === "node.exe" || normalized === "node";
}

function listWindowsNodePidMap() {
  const names = new Map();
  const raw = runSync("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"]);
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("INFO:")) continue;
    const cells = parseCsvLine(line);
    const pid = Number(cells[1]);
    if (Number.isInteger(pid)) names.set(pid, cells[0] || "node.exe");
  }
  return names;
}

function listWindowsNodePorts() {
  const names = listWindowsNodePidMap();
  if (names.size === 0) return [];
  const raw = runSync("netstat", ["-ano"]);
  const rows = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const protocol = parts[0];
    if (protocol !== "TCP" && protocol !== "UDP") continue;
    if (parts.length < 4) continue;

    const state = protocol === "TCP" ? parts[3] : "UDP";
    if (protocol === "TCP" && state !== "LISTENING") continue;

    const pidText = protocol === "TCP" ? parts[4] : parts[3];
    const pid = Number(pidText);
    if (!names.has(pid)) continue;

    const localAddress = parts[1];
    const port = portFromAddress(localAddress);
    if (!isValidPort(port)) continue;

    const key = `${protocol}:${localAddress}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      protocol,
      localAddress,
      port,
      state,
      pid,
      processName: names.get(pid) ?? "node.exe"
    });
  }
  return rows;
}

function listNodePorts() {
  if (process.platform === "win32") return listWindowsNodePorts();
  return listOccupiedPorts(new Set(suggestedPorts())).filter((row) => isNodeProcessName(row.processName));
}

function nodePortsView() {
  const now = Date.now();
  if (nodePortsCache.value && now - nodePortsCache.at < nodePortsCacheMs) return { ...nodePortsCache.value, cached: true };
  const ports = listNodePorts().sort((a, b) => a.port - b.port || Number(a.pid ?? 0) - Number(b.pid ?? 0));
  const value = { checkedAt: new Date().toISOString(), platform: process.platform, cached: false, ports };
  nodePortsCache = { at: now, value };
  return value;
}

function invalidateNodePortsCache() {
  nodePortsCache = { at: 0, value: null };
}

function assertStartupPortFree(port) {
  const occupants = listOccupiedPorts(new Set([Number(port)]));
  if (occupants.length === 0) return;
  const detail = occupants.map((row) => `${row.protocol} ${row.localAddress} pid=${row.pid ?? "unknown"} process=${row.processName ?? "unknown"}`).join("; ");
  const error = new Error(`Port ${port} is already occupied: ${detail}`);
  error.status = 409;
  error.portConflict = { port: Number(port), occupants };
  throw error;
}

function terminateNodeProcessForPort(input) {
  const pid = Number(input?.pid);
  const port = Number(input?.port);
  if (!Number.isInteger(pid) || !isValidPort(port)) throw new Error("Invalid node port termination request.");
  if (process.platform === "win32") {
    const matches = listWindowsNodePorts().filter((row) => row.pid === pid && row.port === port);
    if (matches.length === 0) throw new Error(`PID ${pid} is not a node.exe process currently using port ${port}. Refresh and try again.`);
  }
  const result = terminateProcessForPort({ pid, port });
  invalidateNodePortsCache();
  return result;
}

function terminateProcessForPort(input) {
  const pid = Number(input?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid PID: ${input?.pid}`);
  if (pid === process.pid) throw new Error("Refusing to terminate the control panel process itself.");
  if (pid <= 4) throw new Error(`Refusing to terminate protected/system PID: ${pid}`);

  const port = input?.port == null || input.port === "" ? null : Number(input.port);
  if (port != null) {
    if (!isValidPort(port)) throw new Error(`Invalid port: ${input.port}`);
    const ownsPort = listOccupiedPorts(new Set([port])).some((row) => row.pid === pid);
    if (!ownsPort) throw new Error(`PID ${pid} is not currently using port ${port}. Refresh and try again.`);
  }

  if (process.platform === "win32") {
    runSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } else {
    process.kill(pid, "SIGTERM");
  }
  return { ok: true, pid, port, terminatedAt: new Date().toISOString() };
}

function syncConfig(item, main, configPath) {
  const syncScript = path.join(scriptDir, "sync-repo-config.ps1");
  runSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    syncScript,
    "-ProjectDir",
    path.join(String(main.installRoot), String(main.projectDirName)),
    "-RepoRoot",
    item.repoPath,
    "-RepoMode",
    item.repoMode ?? "read",
    "-AllowNonGit",
    String(item.allowNonGit ?? true),
    "-IncludeChildDirs",
    String(item.includeChildDirs ?? true),
    "-OutputConfig",
    configPath
  ]);
}

function detectTailscaleName() {
  try {
    const raw = runSync("tailscale", ["status", "--json"]);
    const status = JSON.parse(raw);
    return status?.Self?.DNSName ? String(status.Self.DNSName).replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

function httpsBaseUrl(dnsName, httpsPort) {
  return Number(httpsPort) === 443 ? `https://${dnsName}` : `https://${dnsName}:${httpsPort}`;
}

function ensureProxyFunnel(httpsPort) {
  if (proxyFunnelStarted) return;
  runSync("tailscale", ["funnel", "--bg", `--https=${httpsPort}`, `localhost:${proxyPort}`]);
  proxyFunnelStarted = true;
  const dns = detectTailscaleName();
  proxyPublicBaseUrl = dns ? httpsBaseUrl(dns, httpsPort) : `https://YOUR_DEVICE.YOUR_TAILNET.ts.net${Number(httpsPort) === 443 ? "" : `:${httpsPort}`}`;
}

function stopProxyFunnel(httpsPort = 443) {
  if (!proxyFunnelStarted) return;
  try { runSync("tailscale", ["funnel", `--https=${httpsPort}`, "off"]); } catch {}
  proxyFunnelStarted = false;
  proxyPublicBaseUrl = localProxyBaseUrl();
}

function instanceForPublicCode(publicCode) {
  const state = loadState();
  const main = loadMainConfig();
  const textLength = Number(main.tokenLength ?? 32);
  return state.instances.find((item) => publicCodeFor(item.repoPath, textLength) === publicCode);
}

function proxyTargetFromRequest(req) {
  const url = new URL(req.url ?? "/", `http://${proxyHost}:${proxyPort}`);
  const match = url.pathname.match(/^\/t\/([^/]+)\/mcp$/);
  if (!match) return null;
  const item = instanceForPublicCode(match[1]);
  return item ? { item, path: url.pathname + url.search } : null;
}

function forwardToInstance(req, res, item, targetPath) {
  const headers = { ...req.headers, host: `localhost:${item.localPort}` };
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: Number(item.localPort),
      path: targetPath,
      method: req.method,
      headers
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      sendJson(res, { error: `Proxy target failed: ${error.message}` }, 502);
    } else {
      res.destroy(error);
    }
  });

  req.pipe(proxyReq);
}

async function startInstance(id) {
  const state = loadState();
  const item = state.instances.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown instance: ${id}`);
  const existing = runtime.get(id);
  if (existing?.child && !existing.child.killed && !existing.exited) return instanceView(item);

  const main = loadMainConfig();
  const projectDir = path.join(String(main.installRoot), String(main.projectDirName));
  if (!existsSync(path.join(projectDir, "package.json"))) throw new Error(`Project not found: ${projectDir}`);
  if (!existsSync(item.repoPath)) throw new Error(`Repo path not found: ${item.repoPath}`);

  assertStartupPortFree(Number(item.localPort));
  await assertPortAvailable(Number(item.localPort), "127.0.0.1", `MCP instance ${id}`);

  const dir = instanceDir(id);
  ensureDir(dir);
  const configPath = path.join(dir, "config.runtime.json");
  const logPath = path.join(dir, "server.log");
  syncConfig(item, main, configPath);

  const publicCode = publicCodeFor(item.repoPath, Number(main.tokenLength ?? 32));
  const disableToolGate = Boolean(item.disableToolGate);
  const runtimeCode = disableToolGate ? null : randomText(Number(main.tokenLength ?? 32));
  const localUrl = `http://localhost:${proxyPort}/t/${publicCode}/mcp`;

  let proxyWarning = null;
  if (item.useFunnel) {
    const httpsPort = Number(main.proxyHttpsPort ?? item.httpsPort ?? main.httpsPort ?? 443);
    try {
      ensureProxyFunnel(httpsPort);
    } catch (error) {
      proxyWarning = error instanceof Error ? error.message : String(error);
    }
  }

  const url = `${proxyPublicBaseUrl}/t/${publicCode}/mcp`;

  const logStream = createWriteStream(logPath, { flags: "a" });
  const env = { ...process.env };
  env.GPT_REPO_CONFIG = configPath;
  env.PORT = String(item.localPort);
  env["GPT_REPO_PUBLIC_PATH_" + "TO" + "KEN"] = publicCode;
  if (runtimeCode) env.GPT_REPO_TOOL_GATE_CODE = runtimeCode;
  else delete env.GPT_REPO_TOOL_GATE_CODE;
  env.NO_COLOR = "1";

  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", "run", "--silent", "dev"]
    : ["run", "--silent", "dev"];

  logStream.write(`\n[control-panel] ${new Date().toISOString()} starting: ${command} ${args.join(" ")}\n`);
  logStream.write(`[control-panel] cwd: ${projectDir}\n`);
  logStream.write(`[control-panel] config: ${configPath}\n`);
  logStream.write(`[control-panel] mcp_code gate: ${disableToolGate ? "disabled" : "enabled"}\n`);

  let child;
  try {
    child = spawn(command, args, {
      cwd: projectDir,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    logStream.end(`[control-panel] spawn failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    throw error;
  }

  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });

  const live = { child, url, localUrl, runtimeCode, logPath, lastError: proxyWarning, logStream, disableToolGate, exited: false };
  runtime.set(id, live);
  child.on("exit", (code, signal) => {
    live.exited = true;
    live.lastError = code === 0 || signal ? null : `Exited with code ${code}`;
    logStream.end(`[control-panel] exited code=${code} signal=${signal ?? ""}\n`);
  });
  child.on("error", (error) => {
    live.exited = true;
    live.lastError = `${error.message} (command: ${command} ${args.join(" ")}; cwd: ${projectDir}; log: ${logPath})`;
    logStream.end(`[control-panel] child error: ${error instanceof Error ? error.stack : String(error)}\n`);
  });

  return instanceView(item);
}

function stopInstance(id) {
  const state = loadState();
  const item = state.instances.find((candidate) => candidate.id === id);
  const live = runtime.get(id);
  if (live?.child && !live.child.killed) live.child.kill();
  if (live?.logStream && !live.logStream.destroyed) live.logStream.end();
  invalidateNodePortsCache();
  runtime.delete(id);
  return item ? instanceView(item) : { id, running: false };
}

function addInstance(input) {
  const state = loadState();
  const repoPath = resolveConfigPath(input.repoPath, ".");
  if (!repoPath || !existsSync(repoPath)) throw new Error(`Directory does not exist: ${repoPath}`);
  const key = pathKey(repoPath);
  const id = `mcp-${key}`;
  let item = state.instances.find((candidate) => candidate.id === id);
  if (!item) {
    item = {
      id,
      repoPath,
      repoMode: input.repoMode ?? "write",
      localPort: input.localPort ? Number(input.localPort) : pickPort(state),
      useFunnel: input.useFunnel !== false,
      httpsPort: input.httpsPort ? Number(input.httpsPort) : 443,
      allowNonGit: input.allowNonGit !== false,
      includeChildDirs: input.includeChildDirs !== false,
      disableToolGate: input.disableToolGate === true
    };
    state.instances.push(item);
  } else {
    const live = runtime.get(id);
    if (live?.child && !live.child.killed) stopInstance(id);
    item.repoMode = input.repoMode ?? item.repoMode;
    item.localPort = input.localPort ? Number(input.localPort) : item.localPort;
    item.useFunnel = input.useFunnel !== false;
    item.httpsPort = input.httpsPort ? Number(input.httpsPort) : item.httpsPort;
    item.allowNonGit = input.allowNonGit !== false;
    item.includeChildDirs = input.includeChildDirs !== false;
    item.disableToolGate = input.disableToolGate === true;
  }
  saveState(state);
  return instanceView(item);
}

function removeInstance(id) {
  stopInstance(id);
  const state = loadState();
  state.instances = state.instances.filter((item) => item.id !== id);
  saveState(state);
  return { ok: true };
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GPT Repo MCP Control Panel</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#111827;color:#e5e7eb}main{max-width:1180px;margin:0 auto;padding:28px}.card{background:#0f172a;border:1px solid #243244;border-radius:8px;padding:18px;margin:16px 0}h1{margin:0 0 8px;font-size:26px}h2{margin:0 0 14px;font-size:18px}.muted{color:#94a3b8}input,select{background:#0b1220;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:10px;width:100%}label{display:block;font-size:13px;color:#bfdbfe;margin:0 0 6px}input[type="checkbox"]{width:auto}.checkline{display:flex;align-items:center;gap:8px;min-height:39px}.checkline label{margin:0;color:#e5e7eb}.grid{display:grid;grid-template-columns:2fr 120px 120px 150px 120px;gap:12px;align-items:end}.port-grid{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:end}.nowrap{white-space:nowrap}button{background:#2563eb;color:white;border:0;border-radius:8px;padding:10px 13px;cursor:pointer;white-space:nowrap}button.secondary{background:#334155}button.danger{background:#dc2626}table{width:100%;border-collapse:collapse;font-size:14px}th,td{border-bottom:1px solid #243244;padding:12px;text-align:left;vertical-align:top}code{background:#020617;border:1px solid #1e293b;border-radius:7px;padding:3px 6px;word-break:break-all}.ok{color:#86efac}.off{color:#fca5a5}.row-actions{display:flex;gap:8px;flex-wrap:wrap}.small{font-size:12px}.url{max-width:360px}.code{max-width:280px}@media(max-width:900px){main{padding:16px}.grid,.port-grid{grid-template-columns:1fr}table{display:block;overflow:auto}}
</style>
</head>
<body>
<main>
  <h1>GPT Repo MCP Control Panel</h1>
  <div id="state" class="muted">Loading...</div>

  <section class="card">
    <h2>Node.exe Ports</h2>
    <div class="muted small">Only Node.js ports are shown. This list refreshes automatically.</div>
    <div id="portsStatus" class="muted small" style="margin-top:10px">Loading Node.js ports...</div>
    <table id="portTable" style="display:none">
      <thead><tr><th>Port</th><th>PID</th><th>Process</th><th>Protocol</th><th>Address</th><th>Action</th></tr></thead>
      <tbody id="portRows"></tbody>
    </table>
  </section>

  <section class="card">
    <h2>Add Instance</h2>
    <div class="grid">
      <div><label for="repoPath">Repository path</label><input id="repoPath" placeholder="D:\\code_repository\\your_project" /></div>
      <div><label for="repoMode">Mode</label><select id="repoMode"><option value="read">read</option><option value="write" selected>write</option><option value="ship">ship</option></select></div>
      <div><label for="localPort">Local port</label><input id="localPort" placeholder="auto" /></div>
      <div><label>Tool gate</label><div class="checkline"><input id="disableToolGate" type="checkbox" /><label for="disableToolGate">No mcp_code</label></div></div>
      <div><button type="button" onclick="addInstance()">Add</button></div>
    </div>
  </section>

  <section class="card">
    <h2>Instances</h2>
    <table>
      <thead><tr><th>Status</th><th>Repository</th><th>Port</th><th>URL</th><th>mcp_code</th><th>Actions</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </section>
</main>
<script>
async function api(path, options){
  options = options || {};
  var res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options));
  var text = await res.text();
  var data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    var error = new Error(data.error || data.message || text || 'Request failed');
    error.data = data;
    error.status = res.status;
    throw error;
  }
  return data;
}
function text(value){ return value == null ? '' : String(value); }
function setCell(row, value, className){
  var cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text(value);
  row.appendChild(cell);
  return cell;
}
function makeCode(value){
  var code = document.createElement('code');
  code.textContent = text(value);
  return code;
}
function setStatus(message, isError){
  var stateEl = document.getElementById('state');
  stateEl.textContent = message;
  stateEl.className = isError ? 'off' : 'muted';
}
function setPortsStatus(message, isError){
  var stateEl = document.getElementById('portsStatus');
  stateEl.textContent = message;
  stateEl.className = isError ? 'off small' : 'muted small';
}
function clearPorts(message){
  document.getElementById('portRows').replaceChildren();
  document.getElementById('portTable').style.display = 'none';
  setPortsStatus(message || 'Enter a port or range to query.', false);
}
function renderPorts(data){
  var rows = document.getElementById('portRows');
  rows.replaceChildren();
  document.getElementById('portTable').style.display = '';
  var items = data.ports || [];
  if (!items.length) {
    var row = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'muted';
    cell.textContent = 'No Node.js port usage found.';
    row.appendChild(cell);
    rows.appendChild(row);
    return;
  }
  items.forEach(function(item){
    var row = document.createElement('tr');
    setCell(row, item.port, 'nowrap');
    setCell(row, item.pid || 'unknown', 'nowrap');
    setCell(row, item.processName || 'unknown');
    setCell(row, item.protocol + ' ' + item.state, 'nowrap');
    var addrCell = document.createElement('td');
    addrCell.appendChild(makeCode(item.localAddress));
    row.appendChild(addrCell);
    var actionCell = document.createElement('td');
    if (item.pid) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'danger';
      btn.dataset.pid = item.pid;
      btn.dataset.port = item.port;
      btn.textContent = 'Kill PID';
      actionCell.appendChild(btn);
    } else {
      actionCell.textContent = 'PID unavailable';
    }
    row.appendChild(actionCell);
    rows.appendChild(row);
  });
}
async function refreshPorts(){
  if (window.__portsRefreshInFlight) return;
  window.__portsRefreshInFlight = true;

  try {
    var data = await api('/api/node-ports');
    var ports = Array.isArray(data.ports) ? data.ports : [];
    var cacheLabel = data.cached ? ' cached' : '';

    setPortsStatus(
      'Checked ' + ports.length +
      ' Node.js port row(s)' + cacheLabel +
      ' at ' + (data.checkedAt || 'unknown time') +
      ' on ' + (data.platform || 'unknown platform') + '.',
      false
    );

    renderPorts(Object.assign({}, data, { ports: ports }));
  } catch (error) {
    setPortsStatus(
      'Node.js port refresh failed: ' + (error && error.message ? error.message : error),
      true
    );
  } finally {
    window.__portsRefreshInFlight = false;
  }
}
async function killPortPid(pid, port){
  if (!confirm('Kill PID ' + pid + ' that is occupying port ' + port + '?')) return;
  try {
    setPortsStatus('Terminating PID ' + pid + ' ...', false);
    await api('/api/node-ports/' + encodeURIComponent(pid) + '/kill', { method: 'POST', body: JSON.stringify({ port: Number(port) }) });
    await refreshPorts();
  } catch (error) {
    try { await refreshPorts(); } catch {}
    setPortsStatus('Kill failed: ' + (error && error.message ? error.message : error), true);
  }
}
function renderRows(items){
  var rows = document.getElementById('rows');
  rows.replaceChildren();
  if (!items.length) {
    var row = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'muted';
    cell.textContent = 'No instances yet.';
    row.appendChild(cell);
    rows.appendChild(row);
    return;
  }
  items.forEach(function(item){
    var row = document.createElement('tr');

    var statusCell = document.createElement('td');
    var status = document.createElement('b');
    status.className = item.running ? 'ok' : 'off';
    status.textContent = item.running ? 'Running' : 'Stopped';
    statusCell.appendChild(status);
    if (item.lastError) {
      var err = document.createElement('div');
      err.className = 'off small';
      err.textContent = item.lastError;
      statusCell.appendChild(err);
    }
    row.appendChild(statusCell);

    var pathCell = document.createElement('td');
    pathCell.appendChild(makeCode(item.repoPath));
    var id = document.createElement('div');
    id.className = 'muted small';
    id.textContent = item.id;
    pathCell.appendChild(id);
    row.appendChild(pathCell);

    setCell(row, item.localPort);

    var urlCell = document.createElement('td');
    urlCell.className = 'url';
    urlCell.appendChild(item.url ? makeCode(item.url) : document.createTextNode('Not started'));
    row.appendChild(urlCell);

    var codeCell = document.createElement('td');
    codeCell.className = 'code';
    codeCell.appendChild(item.disableToolGate ? document.createTextNode('Disabled') : (item.mcp_code ? makeCode(item.mcp_code) : document.createTextNode('Not started')));
    row.appendChild(codeCell);

    var actionCell = document.createElement('td');
    var actions = document.createElement('div');
    actions.className = 'row-actions';
    [['start','Start',''], ['stop','Stop','secondary'], ['remove','Remove','danger']].forEach(function(spec){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = spec[0];
      btn.dataset.id = item.id;
      btn.textContent = spec[1];
      if (spec[2]) btn.className = spec[2];
      actions.appendChild(btn);
    });
    actionCell.appendChild(actions);
    var log = document.createElement('div');
    log.className = 'muted small';
    log.textContent = 'log: ' + text(item.logPath);
    actionCell.appendChild(log);
    row.appendChild(actionCell);

    rows.appendChild(row);
  });
}
async function refresh(){
  try {
    var data = await api('/api/state');
    var suggested = [data.panel && data.panel.port, data.proxy && data.proxy.port].concat((data.instances || []).map(function(item){ return item.localPort; }));
    window.__suggestedPorts = suggested.filter(function(port, index, all){ return port && all.indexOf(port) === index; });
    setStatus('Panel: http://' + data.panel.host + ':' + data.panel.port + ' | Proxy: ' + data.proxy.publicBaseUrl, false);
    renderRows(data.instances || []);
  } catch (error) {
    setStatus('Refresh failed: ' + (error && error.message ? error.message : error), true);
    document.getElementById('rows').replaceChildren();
  }
}
async function addInstance(){
  var body = {
    repoPath: document.getElementById('repoPath').value,
    repoMode: document.getElementById('repoMode').value,
    localPort: document.getElementById('localPort').value ? Number(document.getElementById('localPort').value) : undefined,
    useFunnel: true,
    disableToolGate: document.getElementById('disableToolGate').checked
  };
  try {
    setStatus('Saving instance config ...', false);
    await api('/api/instances', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('repoPath').value = '';
    document.getElementById('localPort').value = '';
    await refresh();
  } catch (error) {
    try { await refresh(); } catch {}
    setStatus('Save failed: ' + (error && error.message ? error.message : error), true);
  }
}
async function startInstance(id){
  try {
    setStatus('Starting instance ' + id + ' ...', false);
    await api('/api/instances/' + encodeURIComponent(id) + '/start', { method: 'POST' });
    await refresh();
    await refreshPorts();
  } catch (error) {
    try { await refresh(); } catch {}
    window.alert('Start failed: ' + (error && error.message ? error.message : error));
    setStatus('Start failed: ' + (error && error.message ? error.message : error), true);
  }
}
async function stopInstance(id){
  try {
    setStatus('Stopping instance ' + id + ' ...', false);
    await api('/api/instances/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
    await refresh();
    await refreshPorts();
  } catch (error) {
    try { await refresh(); } catch {}
    setStatus('Stop failed: ' + (error && error.message ? error.message : error), true);
  }
}
async function removeInstance(id){
  if (!confirm('Delete this instance config?')) return;
  try {
    setStatus('Removing instance ' + id + ' ...', false);
    await api('/api/instances/' + encodeURIComponent(id), { method: 'DELETE' });
    await refresh();
  } catch (error) {
    try { await refresh(); } catch {}
    setStatus('Remove failed: ' + (error && error.message ? error.message : error), true);
  }
}
document.getElementById('rows').addEventListener('click', function(event){
  var btn = event.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'start') startInstance(btn.dataset.id);
  if (btn.dataset.action === 'stop') stopInstance(btn.dataset.id);
  if (btn.dataset.action === 'remove') removeInstance(btn.dataset.id);
});
document.getElementById('portRows').addEventListener('click', function(event){
  var btn = event.target.closest('button[data-pid][data-port]');
  if (!btn) return;
  killPortPid(btn.dataset.pid, btn.dataset.port);
});
window.addEventListener('error', function(event){
  setStatus('UI error: ' + event.message, true);
});
refresh();
refreshPorts();
setInterval(refresh, 3000);
setInterval(refreshPorts, 5000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${host}:${panelPort}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, listView());
    if (req.method === "GET" && url.pathname === "/api/ports") return sendJson(res, portsView(url.searchParams.get("ports")));
    if (req.method === "GET" && url.pathname === "/api/node-ports") return sendJson(res, nodePortsView());
    const nodePortKillMatch = url.pathname.match(/^\/api\/node-ports\/(\d+)\/kill$/);
    if (nodePortKillMatch && req.method === "POST") return sendJson(res, terminateNodeProcessForPort({ ...(await readBody(req)), pid: nodePortKillMatch[1] }));
    const portKillMatch = url.pathname.match(/^\/api\/ports\/(\d+)\/kill$/);
    if (portKillMatch && req.method === "POST") return sendJson(res, terminateProcessForPort({ ...(await readBody(req)), pid: portKillMatch[1] }));
    if (req.method === "POST" && url.pathname === "/api/instances") return sendJson(res, addInstance(await readBody(req)));
    const match = url.pathname.match(/^\/api\/instances\/([^/]+)(?:\/(start|stop))?$/);
    if (match && req.method === "POST" && match[2] === "start") {
      try {
        return sendJson(res, await startInstance(match[1]));
      } catch (error) {
        const message = rememberInstanceError(match[1], error);
        const status = Number(error?.status ?? 500);
        return sendJson(res, { error: message, portConflict: error?.portConflict ?? null }, status);
      }
    }
    if (match && req.method === "POST" && match[2] === "stop") return sendJson(res, stopInstance(match[1]));
    if (match && req.method === "DELETE") return sendJson(res, removeInstance(match[1]));
    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

const proxyServer = http.createServer((req, res) => {
  const target = proxyTargetFromRequest(req);
  if (!target) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Unknown MCP route" }));
    return;
  }
  forwardToInstance(req, res, target.item, target.path);
});

async function main() {
  ensureDir(runtimeRoot);
  try {
    proxyPort = await listenOnAvailablePort(proxyServer, proxyPort, proxyHost, "GPT Repo MCP Proxy", 0);
    proxyPublicBaseUrl = localProxyBaseUrl();
    console.log(`GPT Repo MCP Proxy: http://${proxyHost}:${proxyPort}`);

    const actualPanelPort = await listenOnAvailablePort(server, panelPort, host, "GPT Repo MCP Control Panel", 0);
    const panelUrl = `http://${host}:${actualPanelPort}`;
    console.log(`GPT Repo MCP Control Panel: ${panelUrl}`);
    openPanelInBrowser(panelUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`GPT Repo MCP Control Panel failed to start: ${message}`);
    try { proxyServer.close(); } catch {}
    try { server.close(); } catch {}
    process.exit(1);
  }
}

await main();

process.on("SIGINT", () => {
  for (const id of runtime.keys()) stopInstance(id);
  stopProxyFunnel(Number(loadMainConfig().proxyHttpsPort ?? loadMainConfig().httpsPort ?? 443));
  process.exit(0);
});


