import { spawnSync } from "node:child_process";

function defaultRunSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export function isValidPort(value) {
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
      if (!isValidPort(start) || !isValidPort(end) || end < start) {
        throw new Error(`Invalid port range: ${part}`);
      }
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

function localSideFromConnectionName(name) {
  return String(name ?? "")
    .replace(/\s+\([^)]+\)$/, "")
    .split("->")[0]
    .trim();
}

function isNodeProcessName(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  return normalized === "node.exe" || normalized === "node";
}

export class PortProcessManager {
  constructor({
    platform = process.platform,
    currentPid = process.pid,
    getProtectedPorts,
    getSuggestedPorts,
    runSync = defaultRunSync,
    killProcess = process.kill.bind(process),
    cacheMs = 3000
  }) {
    if (typeof getProtectedPorts !== "function") throw new Error("getProtectedPorts callback is required.");
    if (typeof getSuggestedPorts !== "function") throw new Error("getSuggestedPorts callback is required.");
    this.platform = platform;
    this.currentPid = currentPid;
    this.getProtectedPorts = getProtectedPorts;
    this.getSuggestedPorts = getSuggestedPorts;
    this.runSync = runSync;
    this.killProcess = killProcess;
    this.cacheMs = cacheMs;
    this.nodePortsCache = { at: 0, value: null };
  }

  isProtectedPort(port) {
    const value = Number(port);
    return this.getProtectedPorts().some((candidate) => Number(candidate) === value);
  }

  portsView(rawPorts) {
    const query = String(rawPorts ?? "").trim();
    const portSet = query ? parsePortFilter(query) : new Set();
    return {
      checkedAt: new Date().toISOString(),
      platform: this.platform,
      query,
      suggestedPorts: this.#suggestedPorts(),
      ports: query ? this.#listOccupiedPorts(portSet) : []
    };
  }

  nodePortsView() {
    const now = Date.now();
    if (this.nodePortsCache.value && now - this.nodePortsCache.at < this.cacheMs) {
      return { ...this.nodePortsCache.value, cached: true };
    }

    const ports = this.#listNodePorts()
      .filter((row) => !this.isProtectedPort(row.port))
      .sort((left, right) => left.port - right.port || Number(left.pid ?? 0) - Number(right.pid ?? 0));
    const value = {
      checkedAt: new Date().toISOString(),
      platform: this.platform,
      cached: false,
      ports
    };
    this.nodePortsCache = { at: now, value };
    return value;
  }

  invalidateCache() {
    this.nodePortsCache = { at: 0, value: null };
  }

  assertStartupPortFree(port) {
    const occupants = this.#listOccupiedPorts(new Set([Number(port)]));
    if (occupants.length === 0) return;

    const detail = occupants
      .map((row) => `${row.protocol} ${row.localAddress} pid=${row.pid ?? "unknown"} process=${row.processName ?? "unknown"}`)
      .join("; ");
    const error = new Error(`Port ${port} is already occupied: ${detail}`);
    error.status = 409;
    error.portConflict = { port: Number(port), occupants };
    throw error;
  }

  terminateNodeProcess(input) {
    const pid = Number(input?.pid);
    const port = Number(input?.port);
    if (!Number.isInteger(pid) || !isValidPort(port)) {
      throw new Error("Invalid node port termination request.");
    }
    if (this.isProtectedPort(port)) {
      throw new Error(`端口 ${port} 已被保护，不能从面板结束。`);
    }
    if (this.platform === "win32") {
      const matches = this.#listWindowsNodePorts().filter((row) => row.pid === pid && row.port === port);
      if (matches.length === 0) {
        throw new Error(`PID ${pid} is not a node.exe process currently using port ${port}. Refresh and try again.`);
      }
    }

    const result = this.terminateProcess({ pid, port });
    this.invalidateCache();
    return result;
  }

  terminateProcess(input) {
    const pid = Number(input?.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid PID: ${input?.pid}`);
    if (pid === this.currentPid) throw new Error("Refusing to terminate the control panel process itself.");
    if (pid <= 4) throw new Error(`Refusing to terminate protected/system PID: ${pid}`);

    const port = input?.port == null || input.port === "" ? null : Number(input.port);
    if (port != null) {
      if (!isValidPort(port)) throw new Error(`Invalid port: ${input.port}`);
      const ownsPort = this.#listOccupiedPorts(new Set([port])).some((row) => row.pid === pid);
      if (!ownsPort) {
        throw new Error(`PID ${pid} is not currently using port ${port}. Refresh and try again.`);
      }
    }

    if (this.platform === "win32") {
      this.runSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } else {
      this.killProcess(pid, "SIGTERM");
    }
    return { ok: true, pid, port, terminatedAt: new Date().toISOString() };
  }

  #suggestedPorts() {
    const ports = new Set([...this.getProtectedPorts(), ...this.getSuggestedPorts()].map(Number));
    return [...ports].filter(isValidPort).sort((left, right) => left - right);
  }

  #processNameMap() {
    const names = new Map();
    if (this.platform === "win32") {
      try {
        const raw = this.runSync("tasklist", ["/FO", "CSV", "/NH"]);
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
      const raw = this.runSync("ps", ["-axo", "pid=,comm="]);
      for (const line of raw.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (match) names.set(Number(match[1]), match[2]);
      }
    } catch {}
    return names;
  }

  #listWindowsOccupiedPorts(portSet, names) {
    const raw = this.runSync("netstat", ["-ano"]);
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

  #listUnixOccupiedPorts(portSet, names) {
    try {
      const raw = this.runSync("lsof", ["-nP", "-iTCP", "-iUDP"]);
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

    const raw = this.runSync("ss", ["-tunap"]);
    const rows = [];
    for (const line of raw.split(/\r?\n/).slice(1)) {
      const parts = line.trim().split(/\s+/);
      const protocol = parts[0]?.toUpperCase();
      if (protocol !== "TCP" && protocol !== "UDP") continue;
      if (parts.length < 5) continue;
      const state = parts[1] || protocol;
      const localAddress = parts[4];
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

  #listOccupiedPorts(portSet) {
    if (!(portSet instanceof Set) || portSet.size === 0) return [];
    const names = this.#processNameMap();
    const rows = this.platform === "win32"
      ? this.#listWindowsOccupiedPorts(portSet, names)
      : this.#listUnixOccupiedPorts(portSet, names);
    const deduped = new Map();
    for (const row of rows) {
      deduped.set(`${row.protocol}:${row.localAddress}:${row.state}:${row.pid ?? ""}`, row);
    }
    return [...deduped.values()].sort((left, right) => (
      left.port - right.port ||
      String(left.protocol).localeCompare(String(right.protocol)) ||
      Number(left.pid ?? 0) - Number(right.pid ?? 0)
    ));
  }

  #listWindowsNodePorts() {
    const names = new Map();
    const taskList = this.runSync("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"]);
    for (const line of taskList.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("INFO:")) continue;
      const cells = parseCsvLine(line);
      const pid = Number(cells[1]);
      if (Number.isInteger(pid)) names.set(pid, cells[0] || "node.exe");
    }
    if (names.size === 0) return [];

    const rows = [];
    const seen = new Set();
    const netstat = this.runSync("netstat", ["-ano"]);
    for (const line of netstat.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const protocol = parts[0];
      if (protocol !== "TCP" && protocol !== "UDP") continue;
      if (parts.length < 4) continue;

      const state = protocol === "TCP" ? parts[3] : "UDP";
      if (protocol === "TCP" && state !== "LISTENING") continue;
      const pid = Number(protocol === "TCP" ? parts[4] : parts[3]);
      if (!names.has(pid)) continue;

      const localAddress = parts[1];
      const port = portFromAddress(localAddress);
      if (!isValidPort(port)) continue;
      const key = `${protocol}:${localAddress}:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ protocol, localAddress, port, state, pid, processName: names.get(pid) ?? "node.exe" });
    }
    return rows;
  }

  #listNodePorts() {
    if (this.platform === "win32") return this.#listWindowsNodePorts();
    return this.#listOccupiedPorts(new Set(this.#suggestedPorts()))
      .filter((row) => isNodeProcessName(row.processName));
  }
}
