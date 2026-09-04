import { spawnSync } from "node:child_process";

function defaultRunSync(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout;
}

function publicBaseUrl(hostAndPort) {
  return `https://${String(hostAndPort).replace(/:443$/, "")}`;
}

function matchingFunnel(status, proxyPort, httpsPort) {
  const web = status?.Web;
  if (!web || typeof web !== "object") return null;
  const allowed = status?.AllowFunnel;
  const proxyTargets = new Set([
    `http://localhost:${proxyPort}`,
    `http://127.0.0.1:${proxyPort}`
  ]);

  for (const [hostAndPort, webConfig] of Object.entries(web)) {
    if (!hostAndPort.endsWith(`:${httpsPort}`)) continue;
    if (allowed && allowed[hostAndPort] !== true) continue;
    const handlers = webConfig?.Handlers;
    if (!handlers || typeof handlers !== "object") continue;
    const proxiesHere = Object.values(handlers)
      .map((handler) => handler?.Proxy)
      .filter((value) => typeof value === "string");
    if (proxiesHere.some((target) => proxyTargets.has(target))) {
      return { hostAndPort, publicBaseUrl: publicBaseUrl(hostAndPort) };
    }
  }
  return null;
}

export class FunnelController {
  constructor({ getProxyPort, getHttpsPort, preserveExisting = false, runSync = defaultRunSync }) {
    if (typeof getProxyPort !== "function") throw new Error("getProxyPort callback is required.");
    if (typeof getHttpsPort !== "function") throw new Error("getHttpsPort callback is required.");
    this.getProxyPort = getProxyPort;
    this.getHttpsPort = getHttpsPort;
    this.preserveExisting = preserveExisting;
    this.runSync = runSync;
    this.started = false;
    this.publicBaseUrl = this.localBaseUrl;
  }

  get localBaseUrl() {
    return `http://localhost:${Number(this.getProxyPort())}`;
  }

  get snapshot() {
    return {
      started: this.started,
      publicBaseUrl: this.publicBaseUrl,
      httpsPort: Number(this.getHttpsPort())
    };
  }

  reconcileOnStartup() {
    if (!this.preserveExisting) return this.stop({ ignoreErrors: true });
    return this.refresh();
  }

  refresh() {
    const raw = this.runSync("tailscale", ["funnel", "status", "--json"]);
    const match = matchingFunnel(
      JSON.parse(raw),
      Number(this.getProxyPort()),
      Number(this.getHttpsPort())
    );
    this.started = Boolean(match);
    this.publicBaseUrl = match?.publicBaseUrl ?? this.localBaseUrl;
    return this.snapshot;
  }

  start() {
    const httpsPort = Number(this.getHttpsPort());
    this.runSync("tailscale", [
      "funnel",
      "--bg",
      `--https=${httpsPort}`,
      `localhost:${Number(this.getProxyPort())}`
    ]);
    return this.refresh();
  }

  stop({ ignoreErrors = false } = {}) {
    const httpsPort = Number(this.getHttpsPort());
    try {
      this.runSync("tailscale", ["funnel", `--https=${httpsPort}`, "off"]);
    } catch (error) {
      if (!ignoreErrors) throw error;
    }
    this.started = false;
    this.publicBaseUrl = this.localBaseUrl;
    return this.snapshot;
  }

  shutdown() {
    if (this.preserveExisting) return this.snapshot;
    return this.stop({ ignoreErrors: true });
  }
}
