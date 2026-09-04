#!/usr/bin/env node
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FunnelController } from "./control-panel/funnel-controller.mjs";
import { InstanceSupervisor } from "./control-panel/instance-supervisor.mjs";
import { createPanelServer } from "./control-panel/panel-server.mjs";
import { controlPanelHtml } from "./control-panel/page.mjs";
import { PortProcessManager } from "./control-panel/port-process-manager.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptDir);
const mainConfigPath = path.join(rootDir, "gpt-repo-mcp.config.json");
const runtimeRoot = path.join(rootDir, ".runtime", "control-panel");
const statePath = path.join(runtimeRoot, "state.json");
const panelPort = Number(process.env.GPT_REPO_PANEL_PORT ?? 8790);
const preserveExistingFunnel = process.env.GPT_REPO_PANEL_PRESERVE_FUNNEL === "1";
let proxyPort = Number(process.env.GPT_REPO_PROXY_PORT ?? 8800);
const proxyHost = "127.0.0.1";
const host = "127.0.0.1";
let instanceSupervisor;
const portProcessManager = new PortProcessManager({
  getProtectedPorts: () => [panelPort, proxyPort],
  getSuggestedPorts: () => instanceSupervisor?.configuredPorts() ?? []
});
const funnelController = new FunnelController({
  getProxyPort: () => proxyPort,
  getHttpsPort: currentProxyHttpsPort,
  preserveExisting: preserveExistingFunnel
});
instanceSupervisor = new InstanceSupervisor({
  rootDir,
  scriptDir,
  runtimeRoot,
  statePath,
  loadMainConfig,
  getProxyState: () => {
    const funnel = funnelController.snapshot;
    return {
      localBaseUrl: funnelController.localBaseUrl,
      publicBaseUrl: funnel.publicBaseUrl,
      funnelRunning: funnel.started
    };
  },
  portProcessManager
});

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function resolveConfigPath(value, fallback = ".") {
  const raw = String(value ?? fallback).trim() || fallback;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(rootDir, raw);
}

function loadMainConfig() {
  if (!existsSync(mainConfigPath)) throw new Error(`Missing config: ${mainConfigPath}`);
  const main = readJson(mainConfigPath, {});
  main.installRoot = resolveConfigPath(main.installRoot ?? ".");
  main.projectDirName = String(main.projectDirName ?? "gpt-repo-mcp");
  main.repoPath = resolveConfigPath(main.repoPath ?? ".");
  return main;
}

function listView() {
  const funnel = funnelController.snapshot;
  return {
    panel: { host, port: panelPort, statePath },
    proxy: { host: proxyHost, port: proxyPort, publicBaseUrl: funnel.publicBaseUrl, funnelStarted: funnel.started },
    instances: instanceSupervisor.listInstances()
  };
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

function selectFolderDialog() {
  let result;
  if (process.platform === "win32") {
    const command = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
      "$dialog.Description = '选择代码仓库文件夹';",
      "$dialog.ShowNewFolderButton = $false;",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }"
    ].join(" ");
    result = spawnSync("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", windowsHide: false });
  } else if (process.platform === "darwin") {
    result = spawnSync("osascript", ["-e", "POSIX path of (choose folder with prompt \"选择代码仓库文件夹\")"], { encoding: "utf8" });
  } else {
    result = spawnSync("zenity", ["--file-selection", "--directory", "--title=选择代码仓库文件夹"], { encoding: "utf8" });
  }

  if (result.error) throw result.error;
  if (result.status !== 0) {
    return { path: null, cancelled: true, platform: process.platform };
  }

  const selectedPath = String(result.stdout ?? "").trim();
  if (!selectedPath) return { path: null, cancelled: true, platform: process.platform };
  return { path: path.normalize(selectedPath), cancelled: false, platform: process.platform };
}

function currentProxyHttpsPort() {
  const main = loadMainConfig();
  return Number(main.proxyHttpsPort ?? main.httpsPort ?? 443);
}

function proxyTargetFromRequest(req) {
  const url = new URL(req.url ?? "/", `http://${proxyHost}:${proxyPort}`);
  const match = url.pathname.match(/^\/t\/([^/]+)\/mcp$/);
  if (!match) return null;
  const item = instanceSupervisor.findByPublicCode(match[1]);
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
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `Proxy target failed: ${error.message}` }));
    } else {
      res.destroy(error);
    }
  });

  req.pipe(proxyReq);
}

const server = createPanelServer({
  html: controlPanelHtml,
  actions: {
    getState: listView,
    startFunnel: () => funnelController.start(),
    stopFunnel: () => funnelController.stop(),
    getPorts: (query) => portProcessManager.portsView(query),
    getNodePorts: () => portProcessManager.nodePortsView(),
    selectFolder: selectFolderDialog,
    initializeMcp: (id) => instanceSupervisor.initializeMcp(id),
    listMcpTools: (id) => instanceSupervisor.listMcpTools(id),
    callMcpTool: (id, input) => instanceSupervisor.callMcpTool(id, input),
    terminateNodeProcess: (input) => portProcessManager.terminateNodeProcess(input),
    terminateProcess: (input) => portProcessManager.terminateProcess(input),
    addInstance: (input) => instanceSupervisor.add(input),
    startInstance: (id) => instanceSupervisor.start(id),
    stopInstance: (id) => instanceSupervisor.stop(id),
    removeInstance: (id) => instanceSupervisor.remove(id)
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
  instanceSupervisor.prepare();
  try {
    proxyPort = await listenOnAvailablePort(proxyServer, proxyPort, proxyHost, "GPT Repo MCP Proxy", 0);
    funnelController.reconcileOnStartup();
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

process.on("SIGINT", async () => {
  await instanceSupervisor.shutdown();
  funnelController.shutdown();
  process.exit(0);
});


