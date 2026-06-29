#!/usr/bin/env node
import http from "node:http";
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

function normalizeRepoPath(repoPath) {
  return path.resolve(repoPath).replace(/[\\/]+$/, "").toLowerCase();
}

function pathKey(repoPath) {
  return createHash("sha256").update(normalizeRepoPath(repoPath)).digest("hex").slice(0, 16);
}

function loadMainConfig() {
  if (!existsSync(mainConfigPath)) throw new Error(`Missing config: ${mainConfigPath}`);
  return readJson(mainConfigPath, {});
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

function publicCodeFor(repoPath, length) {
  const key = pathKey(repoPath);
  const filePath = path.join(runtimeRoot, `public-path-code-${key}.txt`);
  if (existsSync(filePath)) return readFileSync(filePath, "utf8").trim();
  const code = randomText(length);
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
    running: Boolean(live?.child && !live.child.killed),
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

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  return result.stdout;
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

function startInstance(id) {
  const state = loadState();
  const item = state.instances.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown instance: ${id}`);
  const existing = runtime.get(id);
  if (existing?.child && !existing.child.killed) return instanceView(item);

  const main = loadMainConfig();
  const projectDir = path.join(String(main.installRoot), String(main.projectDirName));
  if (!existsSync(path.join(projectDir, "package.json"))) throw new Error(`Project not found: ${projectDir}`);
  if (!existsSync(item.repoPath)) throw new Error(`Repo path not found: ${item.repoPath}`);

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

  const live = { child, url, localUrl, runtimeCode, logPath, lastError: proxyWarning, logStream, disableToolGate };
  runtime.set(id, live);
  child.on("exit", (code, signal) => {
    live.lastError = code === 0 || signal ? null : `Exited with code ${code}`;
    logStream.end(`[control-panel] exited code=${code} signal=${signal ?? ""}\n`);
  });
  child.on("error", (error) => {
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
  runtime.delete(id);
  return item ? instanceView(item) : { id, running: false };
}

function addInstance(input) {
  const state = loadState();
  const repoPath = path.resolve(String(input.repoPath ?? ""));
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
:root{color-scheme:dark}*{box-sizing:border-box}body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#111827;color:#e5e7eb}main{max-width:1180px;margin:0 auto;padding:28px}.card{background:#0f172a;border:1px solid #243244;border-radius:8px;padding:18px;margin:16px 0}h1{margin:0 0 8px;font-size:26px}h2{margin:0 0 14px;font-size:18px}.muted{color:#94a3b8}input,select{background:#0b1220;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:10px;width:100%}label{display:block;font-size:13px;color:#bfdbfe;margin:0 0 6px}input[type="checkbox"]{width:auto}.checkline{display:flex;align-items:center;gap:8px;min-height:39px}.checkline label{margin:0;color:#e5e7eb}.grid{display:grid;grid-template-columns:2fr 120px 120px 150px 120px;gap:12px;align-items:end}button{background:#2563eb;color:white;border:0;border-radius:8px;padding:10px 13px;cursor:pointer;white-space:nowrap}button.secondary{background:#334155}button.danger{background:#dc2626}table{width:100%;border-collapse:collapse;font-size:14px}th,td{border-bottom:1px solid #243244;padding:12px;text-align:left;vertical-align:top}code{background:#020617;border:1px solid #1e293b;border-radius:7px;padding:3px 6px;word-break:break-all}.ok{color:#86efac}.off{color:#fca5a5}.row-actions{display:flex;gap:8px;flex-wrap:wrap}.small{font-size:12px}.url{max-width:360px}.code{max-width:280px}@media(max-width:900px){main{padding:16px}.grid{grid-template-columns:1fr}table{display:block;overflow:auto}}
</style>
</head>
<body>
<main>
  <h1>GPT Repo MCP Control Panel</h1>
  <div id="state" class="muted">Loading...</div>

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
  if (!res.ok) throw new Error(data.error || data.message || text || 'Request failed');
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
  } catch (error) {
    try { await refresh(); } catch {}
    setStatus('Start failed: ' + (error && error.message ? error.message : error), true);
  }
}
async function stopInstance(id){
  try {
    setStatus('Stopping instance ' + id + ' ...', false);
    await api('/api/instances/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
    await refresh();
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
window.addEventListener('error', function(event){
  setStatus('UI error: ' + event.message, true);
});
refresh();
setInterval(refresh, 3000);
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
    if (req.method === "POST" && url.pathname === "/api/instances") return sendJson(res, addInstance(await readBody(req)));
    const match = url.pathname.match(/^\/api\/instances\/([^/]+)(?:\/(start|stop))?$/);
    if (match && req.method === "POST" && match[2] === "start") {
      try {
        return sendJson(res, startInstance(match[1]));
      } catch (error) {
        const message = rememberInstanceError(match[1], error);
        return sendJson(res, { error: message }, 500);
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

    await listenOnAvailablePort(server, panelPort, host, "GPT Repo MCP Control Panel", 0);
    console.log(`GPT Repo MCP Control Panel: http://${host}:${panelPort}`);
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


