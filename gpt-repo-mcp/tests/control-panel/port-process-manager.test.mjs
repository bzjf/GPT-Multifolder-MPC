import assert from "node:assert/strict";
import test from "node:test";
import { PortProcessManager } from "../../../scripts/control-panel/port-process-manager.mjs";

const WINDOWS_TASKS = '"node.exe","42","Console","1","10,000 K"\n"other.exe","99","Console","1","5,000 K"';
const WINDOWS_PORTS = [
  "TCP    127.0.0.1:8788    0.0.0.0:0    LISTENING    42",
  "TCP    127.0.0.1:8790    0.0.0.0:0    LISTENING    99"
].join("\n");

function windowsManager(commands = []) {
  return new PortProcessManager({
    platform: "win32",
    currentPid: 500,
    getProtectedPorts: () => [8790, 8800],
    getSuggestedPorts: () => [8788],
    runSync: (command, args) => {
      commands.push([command, args]);
      if (command === "tasklist") return WINDOWS_TASKS;
      if (command === "netstat") return WINDOWS_PORTS;
      if (command === "taskkill") return "SUCCESS";
      throw new Error(`Unexpected command: ${command}`);
    }
  });
}

test("PortProcessManager inspects requested Windows ports and resolves process names", () => {
  const view = windowsManager().portsView("8788,8790");
  assert.deepEqual(view.suggestedPorts, [8788, 8790, 8800]);
  assert.deepEqual(view.ports.map((row) => ({ port: row.port, pid: row.pid, processName: row.processName })), [
    { port: 8788, pid: 42, processName: "node.exe" },
    { port: 8790, pid: 99, processName: "other.exe" }
  ]);
});

test("PortProcessManager protects panel ports and verifies ownership before termination", () => {
  const commands = [];
  const manager = windowsManager(commands);
  assert.throws(() => manager.terminateNodeProcess({ pid: 99, port: 8790 }), /已被保护/);
  const result = manager.terminateNodeProcess({ pid: 42, port: 8788 });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 42);
  assert(commands.some(([command, args]) => command === "taskkill" && args[1] === "42"));
});

test("PortProcessManager reports structured startup conflicts", () => {
  const manager = windowsManager();
  assert.throws(() => manager.assertStartupPortFree(8788), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.portConflict.port, 8788);
    assert.equal(error.portConflict.occupants[0].pid, 42);
    return true;
  });
});

test("PortProcessManager uses the Unix adapter and rejects excessive ranges", () => {
  const manager = new PortProcessManager({
    platform: "linux",
    getProtectedPorts: () => [],
    getSuggestedPorts: () => [8788],
    runSync: (command) => {
      if (command === "ps") return "42 node\n";
      if (command === "lsof") return "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 42 user 10u IPv4 12345 0t0 TCP 127.0.0.1:8788 (LISTEN)";
      throw new Error(`Unexpected command: ${command}`);
    }
  });

  assert.equal(manager.portsView("8788").ports[0].processName, "node");
  assert.throws(() => manager.portsView("1-3002"), /range is too large/);
});
