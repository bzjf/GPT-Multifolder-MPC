import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { InstanceSupervisor } from "../../../scripts/control-panel/instance-supervisor.mjs";

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, signal);
  };
  return child;
}

function createHarness({ waitUntilReady } = {}) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "gpt-mcp-supervisor-"));
  const scriptDir = path.join(rootDir, "scripts");
  const runtimeRoot = path.join(rootDir, ".runtime", "control-panel");
  const statePath = path.join(runtimeRoot, "state.json");
  const projectRoot = path.join(rootDir, "install", "gpt-repo-mcp");
  const repoPath = path.join(rootDir, "repo");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(projectRoot, "package.json"), "{}", "utf8");

  const children = [];
  const commands = [];
  const portProcessManager = {
    isProtectedPort: (port) => [8790, 8800].includes(Number(port)),
    assertStartupPortFree: () => {},
    invalidateCache: () => {}
  };
  const supervisor = new InstanceSupervisor({
    rootDir,
    scriptDir,
    runtimeRoot,
    statePath,
    loadMainConfig: () => ({
      installRoot: path.join(rootDir, "install"),
      projectDirName: "gpt-repo-mcp",
      localPort: 8787,
      tokenLength: 32
    }),
    getProxyState: () => ({
      localBaseUrl: "http://localhost:8800",
      publicBaseUrl: "https://device.tailnet.ts.net",
      funnelRunning: true
    }),
    portProcessManager,
    platform: "win32",
    spawnProcess: () => {
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    runSync: (command, args) => {
      commands.push([command, args]);
      if (command === "taskkill") {
        const child = children.find((candidate) => candidate.pid === Number(args[1]));
        if (child && child.exitCode === null) {
          child.killed = true;
          child.exitCode = 0;
          child.emit("exit", 0, "SIGTERM");
        }
      }
      return "";
    },
    waitUntilReady: waitUntilReady ?? (async ({ isProcessRunning }) => {
      assert.equal(isProcessRunning(), true);
      return { readyAt: "2026-09-04T00:00:00.000Z" };
    })
  });

  return {
    rootDir,
    repoPath,
    runtimeRoot,
    statePath,
    commands,
    supervisor,
    async cleanup() {
      await supervisor.shutdown();
      rmSync(rootDir, { recursive: true, force: true });
    }
  };
}

test("InstanceSupervisor migrates legacy instance state to one Funnel source", async () => {
  const harness = createHarness();
  try {
    mkdirSync(harness.runtimeRoot, { recursive: true });
    writeFileSync(harness.statePath, JSON.stringify({
      nextPort: 8798,
      instances: [{
        id: "mcp-legacy",
        repoPath: harness.repoPath,
        repoMode: "read",
        localPort: 8788,
        useFunnel: false,
        httpsPort: 8443
      }]
    }), "utf8");

    harness.supervisor.prepare();
    const persisted = JSON.parse(readFileSync(harness.statePath, "utf8"));
    assert.equal("useFunnel" in persisted.instances[0], false);
    assert.equal("httpsPort" in persisted.instances[0], false);
    assert.equal(harness.supervisor.listInstances()[0].funnelRunning, true);
  } finally {
    await harness.cleanup();
  }
});

test("InstanceSupervisor start waits for readiness before reporting MCP ready", async () => {
  const harness = createHarness();
  try {
    harness.supervisor.prepare();
    const added = harness.supervisor.add({
      repoPath: harness.repoPath,
      repoMode: "write",
      localPort: 8788,
      disableToolGate: true
    });
    assert.equal(added.lifecycle, "stopped");

    const started = await harness.supervisor.start(added.id);
    assert.equal(started.processRunning, true);
    assert.equal(started.mcpReady, true);
    assert.equal(started.lifecycle, "ready");
    assert.equal(started.readyAt, "2026-09-04T00:00:00.000Z");
    assert.match(started.localUrl, /^http:\/\/localhost:8800\/t\/[a-f0-9]+\/mcp$/);

    const stopped = harness.supervisor.stop(added.id);
    assert.equal(stopped.mcpReady, false);
    assert.equal(stopped.lifecycle, "stopped");
    assert(harness.commands.some(([command]) => command === "taskkill"));
  } finally {
    await harness.cleanup();
  }
});

test("InstanceSupervisor cleans failed startup and rejects tester use before readiness", async () => {
  const harness = createHarness({
    waitUntilReady: async () => {
      throw new Error("health timed out");
    }
  });
  try {
    harness.supervisor.prepare();
    const added = harness.supervisor.add({ repoPath: harness.repoPath, localPort: 8788 });
    await assert.rejects(harness.supervisor.initializeMcp(added.id), (error) => error.status === 409);
    await assert.rejects(harness.supervisor.start(added.id), (error) => (
      error.status === 503 && /health timed out/.test(error.message)
    ));
    const failed = harness.supervisor.listInstances()[0];
    assert.equal(failed.processRunning, false);
    assert.equal(failed.mcpReady, false);
    assert.equal(failed.lifecycle, "failed");
  } finally {
    await harness.cleanup();
  }
});
