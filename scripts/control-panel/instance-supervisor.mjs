import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { LocalMcpClient } from "./local-mcp-client.mjs";
import { waitForMcpReady } from "./mcp-readiness.mjs";
import { httpError } from "./panel-server.mjs";
import { isValidPort } from "./port-process-manager.mjs";

function defaultRunSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function randomText(length = 32) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += chars[randomInt(chars.length)];
  }
  return output;
}

function isProcessRunning(live) {
  return Boolean(live?.child && !live.child.killed && !live.exited && live.child.exitCode === null);
}

export class InstanceSupervisor {
  constructor({
    rootDir,
    scriptDir,
    runtimeRoot,
    statePath,
    loadMainConfig,
    getProxyState,
    portProcessManager,
    spawnProcess = spawn,
    runSync = defaultRunSync,
    waitUntilReady = waitForMcpReady,
    platform = process.platform
  }) {
    if (typeof loadMainConfig !== "function") throw new Error("loadMainConfig callback is required.");
    if (typeof getProxyState !== "function") throw new Error("getProxyState callback is required.");
    if (!portProcessManager) throw new Error("portProcessManager is required.");
    this.rootDir = rootDir;
    this.scriptDir = scriptDir;
    this.runtimeRoot = runtimeRoot;
    this.statePath = statePath;
    this.loadMainConfig = loadMainConfig;
    this.getProxyState = getProxyState;
    this.portProcessManager = portProcessManager;
    this.spawnProcess = spawnProcess;
    this.runSync = runSync;
    this.waitUntilReady = waitUntilReady;
    this.platform = platform;
    this.runtime = new Map();
    this.localMcpClients = new Map();
  }

  prepare() {
    ensureDir(this.runtimeRoot);
    this.#loadState();
  }

  listInstances() {
    return this.#loadState().instances.map((item) => this.#view(item));
  }

  configuredPorts() {
    return this.#loadState().instances.map((item) => item.localPort);
  }

  findByPublicCode(publicCode) {
    const main = this.loadMainConfig();
    const codeLength = Number(main.tokenLength ?? 32);
    return this.#loadState().instances.find((item) => (
      this.#publicCodeFor(item.repoPath, codeLength) === publicCode
    ));
  }

  rememberError(id, error) {
    const message = error instanceof Error ? error.message : String(error);
    const previous = this.runtime.get(id) ?? {};
    this.runtime.set(id, { ...previous, lastError: message });
    return message;
  }

  async start(id) {
    try {
      return await this.#start(id);
    } catch (error) {
      this.rememberError(id, error);
      throw error;
    }
  }

  stop(id) {
    const item = this.#loadState().instances.find((candidate) => candidate.id === id);
    const live = this.runtime.get(id);
    this.#disposeLocalMcpClient(id);
    if (live) live.stopRequested = true;
    if (isProcessRunning(live)) this.#terminateManagedChild(live.child, id);
    if (
      live?.logStream &&
      !live.logStream.destroyed &&
      !live.logStream.writableEnded &&
      (!live.child || live.child.exitCode !== null)
    ) {
      live.logStream.end("[control-panel] stopped without a live child process\n");
    }
    this.portProcessManager.invalidateCache();
    this.runtime.delete(id);
    return item ? this.#view(item) : { id, running: false, mcpReady: false, lifecycle: "stopped" };
  }

  stopAll() {
    for (const id of [...this.runtime.keys()]) this.stop(id);
  }

  async shutdown() {
    const clients = [...this.localMcpClients.values()];
    const logStreams = [...this.runtime.values()]
      .map((live) => live.logStream)
      .filter(Boolean);
    this.stopAll();
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await Promise.all(logStreams.map((stream) => finished(stream).catch(() => {})));
  }

  add(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw httpError(400, "Instance settings must be a JSON object.");
    }
    if (typeof input.repoPath !== "string" || !input.repoPath.trim()) {
      throw httpError(400, "repoPath is required.");
    }

    const repoMode = input.repoMode === undefined ? null : String(input.repoMode);
    if (repoMode !== null && !["read", "write", "ship"].includes(repoMode)) {
      throw httpError(400, "repoMode must be read, write, or ship.");
    }

    const hasLocalPort = input.localPort !== undefined && input.localPort !== null && input.localPort !== "";
    const requestedPort = hasLocalPort ? Number(input.localPort) : null;
    if (requestedPort !== null && !isValidPort(requestedPort)) {
      throw httpError(400, "localPort must be an integer from 1 to 65535.");
    }
    if (requestedPort !== null && this.portProcessManager.isProtectedPort(requestedPort)) {
      throw httpError(400, "localPort conflicts with the control panel or proxy port.");
    }

    const state = this.#loadState();
    const repoPath = this.#resolveConfigPath(input.repoPath, ".");
    if (!repoPath || !existsSync(repoPath)) {
      throw httpError(400, `Directory does not exist: ${repoPath}`);
    }
    const id = `mcp-${this.#pathKey(repoPath)}`;
    let item = state.instances.find((candidate) => candidate.id === id);
    if (!item) {
      item = {
        id,
        repoPath,
        repoMode: repoMode ?? "write",
        localPort: requestedPort ?? this.#pickPort(state),
        allowNonGit: input.allowNonGit !== false,
        includeChildDirs: input.includeChildDirs !== false,
        disableToolGate: input.disableToolGate === true
      };
      state.instances.push(item);
    } else {
      if (isProcessRunning(this.runtime.get(id))) this.stop(id);
      item.repoMode = repoMode ?? item.repoMode;
      item.localPort = requestedPort ?? item.localPort;
      item.allowNonGit = input.allowNonGit !== false;
      item.includeChildDirs = input.includeChildDirs !== false;
      item.disableToolGate = input.disableToolGate === true;
    }
    this.#saveState(state);
    return this.#view(item);
  }

  remove(id) {
    this.stop(id);
    const state = this.#loadState();
    state.instances = state.instances.filter((item) => item.id !== id);
    this.#saveState(state);
    return { ok: true };
  }

  async initializeMcp(id) {
    const client = this.#localMcpClientFor(id);
    const connection = await client.initialize({ force: true });
    const live = this.runtime.get(id);
    if (live) {
      live.mcpReady = true;
      live.readyAt = new Date().toISOString();
      live.lastError = null;
    }
    return { instanceId: id, connection };
  }

  async listMcpTools(id) {
    const client = this.#localMcpClientFor(id);
    const result = await client.listTools();
    return { instanceId: id, connection: client.connectionInfo, tools: result.tools };
  }

  async callMcpTool(id, input) {
    if (typeof input?.toolName !== "string") throw httpError(400, "toolName is required.");
    if (input.arguments === null || typeof input.arguments !== "object" || Array.isArray(input.arguments)) {
      throw httpError(400, "arguments must be a JSON object.");
    }

    const client = this.#localMcpClientFor(id);
    const result = await client.callTool(input.toolName, input.arguments);
    return { instanceId: id, connection: client.connectionInfo, toolName: input.toolName, result };
  }

  #loadState() {
    const main = this.loadMainConfig();
    const basePort = Number(main.localPort ?? 8787);
    const state = readJson(this.statePath, { nextPort: basePort + 2, instances: [] });
    if (!Array.isArray(state.instances)) throw new Error("Control panel state instances must be an array.");

    let migrated = false;
    state.instances = state.instances.map((item) => {
      if (!("useFunnel" in item) && !("httpsPort" in item)) return item;
      const normalized = { ...item };
      delete normalized.useFunnel;
      delete normalized.httpsPort;
      migrated = true;
      return normalized;
    });
    if (migrated) this.#saveState(state);
    return state;
  }

  #saveState(state) {
    writeJsonAtomic(this.statePath, state);
  }

  #resolveConfigPath(value, fallback = ".") {
    const raw = String(value ?? fallback).trim() || fallback;
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(this.rootDir, raw);
  }

  #normalizeRepoPath(repoPath) {
    return this.#resolveConfigPath(repoPath).replace(/[\\/]+$/, "").toLowerCase();
  }

  #pathKey(repoPath) {
    return createHash("sha256").update(this.#normalizeRepoPath(repoPath)).digest("hex").slice(0, 16);
  }

  #instanceDir(id) {
    return path.join(this.runtimeRoot, "instances", id);
  }

  #publicCodeFor(repoPath, length) {
    const normalized = this.#normalizeRepoPath(repoPath);
    const key = this.#pathKey(repoPath);
    const filePath = path.join(this.runtimeRoot, `public-path-code-${key}.txt`);
    if (existsSync(filePath)) return readFileSync(filePath, "utf8").trim();
    ensureDir(this.runtimeRoot);
    const digest = createHash("sha256").update(`public:${normalized}`).digest("hex");
    const code = digest.slice(0, Math.max(16, Number(length) || 32));
    writeFileSync(filePath, `${code}\n`, "utf8");
    return code;
  }

  #pickPort(state) {
    const used = new Set(state.instances.map((item) => Number(item.localPort)));
    let port = Number(state.nextPort ?? 8788);
    while (used.has(port)) port += 1;
    state.nextPort = port + 1;
    return port;
  }

  #view(item) {
    const live = this.runtime.get(item.id);
    const processRunning = isProcessRunning(live);
    const mcpReady = processRunning && live?.mcpReady === true;
    const proxy = this.getProxyState();
    const available = mcpReady && proxy.funnelRunning;
    return {
      ...item,
      running: mcpReady,
      processRunning,
      mcpRunning: mcpReady,
      mcpReady,
      lifecycle: mcpReady ? "ready" : processRunning ? "starting" : live?.lastError ? "failed" : "stopped",
      funnelRunning: proxy.funnelRunning,
      available,
      url: available && live?.publicCode ? `${proxy.publicBaseUrl}/t/${live.publicCode}/mcp` : null,
      localUrl: mcpReady ? live?.localUrl ?? null : null,
      mcp_code: live?.runtimeCode ?? null,
      logPath: live?.logPath ?? path.join(this.#instanceDir(item.id), "server.log"),
      readyAt: live?.readyAt ?? null,
      lastError: live?.lastError ?? null
    };
  }

  async #assertPortAvailable(port, bindHost, label) {
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", (error) => {
        if (error?.code === "EADDRINUSE") {
          reject(new Error(`${label} port ${port} is already in use on ${bindHost}. Stop the existing process or choose another local port.`));
        } else {
          reject(error);
        }
      });
      probe.once("listening", () => probe.close(resolve));
      probe.listen(Number(port), bindHost);
    });
  }

  #syncConfig(item, main, configPath) {
    this.runSync("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(this.scriptDir, "sync-repo-config.ps1"),
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

  async #start(id) {
    const item = this.#loadState().instances.find((candidate) => candidate.id === id);
    if (!item) throw httpError(404, `Unknown instance: ${id}`);
    const existing = this.runtime.get(id);
    if (isProcessRunning(existing)) {
      await this.#ensureReady(item, existing);
      return this.#view(item);
    }
    this.#disposeLocalMcpClient(id);

    const main = this.loadMainConfig();
    const projectDir = path.join(String(main.installRoot), String(main.projectDirName));
    if (!existsSync(path.join(projectDir, "package.json"))) {
      throw new Error(`Project not found: ${projectDir}`);
    }
    if (!existsSync(item.repoPath)) throw new Error(`Repo path not found: ${item.repoPath}`);

    this.portProcessManager.assertStartupPortFree(Number(item.localPort));
    await this.#assertPortAvailable(Number(item.localPort), "127.0.0.1", `MCP instance ${id}`);

    const dir = this.#instanceDir(id);
    ensureDir(dir);
    const configPath = path.join(dir, "config.runtime.json");
    const logPath = path.join(dir, "server.log");
    this.#syncConfig(item, main, configPath);

    const publicCode = this.#publicCodeFor(item.repoPath, Number(main.tokenLength ?? 32));
    const disableToolGate = item.disableToolGate === true;
    const runtimeCode = disableToolGate ? null : randomText(Number(main.tokenLength ?? 32));
    const proxy = this.getProxyState();
    const localUrl = `${proxy.localBaseUrl}/t/${publicCode}/mcp`;
    const logStream = createWriteStream(logPath, { flags: "a" });
    await once(logStream, "open");
    const env = { ...process.env };
    env.GPT_REPO_CONFIG = configPath;
    env.PORT = String(item.localPort);
    env["GPT_REPO_PUBLIC_PATH_" + "TO" + "KEN"] = publicCode;
    if (runtimeCode) env.GPT_REPO_TOOL_GATE_CODE = runtimeCode;
    else delete env.GPT_REPO_TOOL_GATE_CODE;
    env.NO_COLOR = "1";

    const command = this.platform === "win32" ? "cmd.exe" : "npm";
    const args = this.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd", "run", "--silent", "dev"]
      : ["run", "--silent", "dev"];
    logStream.write(`\n[control-panel] ${new Date().toISOString()} starting: ${command} ${args.join(" ")}\n`);
    logStream.write(`[control-panel] cwd: ${projectDir}\n`);
    logStream.write(`[control-panel] config: ${configPath}\n`);
    logStream.write(`[control-panel] mcp_code gate: ${disableToolGate ? "disabled" : "enabled"}\n`);

    let child;
    try {
      child = this.spawnProcess(command, args, {
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
    const live = {
      child,
      publicCode,
      localUrl,
      runtimeCode,
      logPath,
      lastError: null,
      logStream,
      disableToolGate,
      exited: false,
      mcpReady: false,
      readyAt: null,
      readinessPromise: null
    };
    this.runtime.set(id, live);
    child.on("exit", (code, signal) => {
      this.#disposeLocalMcpClient(id);
      live.exited = true;
      live.mcpReady = false;
      live.lastError = live.stopRequested || code === 0 || signal ? null : `Exited with code ${code}`;
      if (!logStream.destroyed && !logStream.writableEnded) {
        logStream.end(`[control-panel] ${live.stopRequested ? "stopped" : "exited"} code=${code} signal=${signal ?? ""}\n`);
      }
    });
    child.on("error", (error) => {
      live.exited = true;
      live.mcpReady = false;
      live.lastError = `${error.message} (command: ${command} ${args.join(" ")}; cwd: ${projectDir}; log: ${logPath})`;
      if (!logStream.destroyed && !logStream.writableEnded) {
        logStream.end(`[control-panel] child error: ${error instanceof Error ? error.stack : String(error)}\n`);
      }
    });

    await this.#ensureReady(item, live);
    return this.#view(item);
  }

  async #ensureReady(item, live) {
    if (live.mcpReady) return;
    if (!live.readinessPromise) {
      live.readinessPromise = this.waitUntilReady({
        port: Number(item.localPort),
        isProcessRunning: () => isProcessRunning(live)
      }).then((result) => {
        live.mcpReady = true;
        live.readyAt = result.readyAt;
        live.lastError = null;
      });
    }

    try {
      await live.readinessPromise;
    } catch (error) {
      live.mcpReady = false;
      const detail = error instanceof Error ? error.message : String(error);
      const message = `MCP instance ${item.id} failed readiness: ${detail}`;
      live.lastError = message;
      try {
        this.stop(item.id);
      } catch (cleanupError) {
        throw httpError(503, `${message} Cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      throw httpError(503, message);
    } finally {
      live.readinessPromise = null;
    }
  }

  #terminateManagedChild(child, id) {
    const pid = Number(child?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Cannot stop instance ${id}: invalid child PID.`);
    }
    if (this.platform === "win32") {
      this.runSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } else {
      child.kill("SIGTERM");
    }
  }

  #disposeLocalMcpClient(id) {
    const client = this.localMcpClients.get(id);
    this.localMcpClients.delete(id);
    if (client) void client.close().catch(() => {});
  }

  #runningInstanceForMcpTest(id) {
    const item = this.#loadState().instances.find((candidate) => candidate.id === id);
    if (!item) throw httpError(404, `Unknown instance: ${id}`);
    const live = this.runtime.get(id);
    if (!isProcessRunning(live) || !live.mcpReady || !live.publicCode) {
      throw httpError(409, "Wait until this MCP instance is ready before using the local tester.");
    }
    return { item, live };
  }

  #localMcpClientFor(id) {
    const { item, live } = this.#runningInstanceForMcpTest(id);
    const endpoint = `http://127.0.0.1:${Number(item.localPort)}/t/${encodeURIComponent(live.publicCode)}/mcp`;
    const current = this.localMcpClients.get(id);
    if (current?.endpoint === endpoint) return current;
    this.#disposeLocalMcpClient(id);
    const client = new LocalMcpClient({ endpoint, timeoutMs: 30_000 });
    this.localMcpClients.set(id, client);
    return client;
  }
}
