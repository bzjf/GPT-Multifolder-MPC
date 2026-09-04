import assert from "node:assert/strict";
import test from "node:test";
import { FunnelController } from "../../../scripts/control-panel/funnel-controller.mjs";

function statusJson({ proxyPort = 8800, httpsPort = 443 } = {}) {
  const hostAndPort = `device.tailnet.ts.net:${httpsPort}`;
  return JSON.stringify({
    Web: {
      [hostAndPort]: {
        Handlers: { "/": { Proxy: `http://localhost:${proxyPort}` } }
      }
    },
    AllowFunnel: { [hostAndPort]: true }
  });
}

test("FunnelController reconciles a preserved external Funnel", () => {
  const commands = [];
  const controller = new FunnelController({
    getProxyPort: () => 8800,
    getHttpsPort: () => 443,
    preserveExisting: true,
    runSync: (command, args) => {
      commands.push([command, args]);
      return statusJson();
    }
  });

  assert.deepEqual(controller.reconcileOnStartup(), {
    started: true,
    publicBaseUrl: "https://device.tailnet.ts.net",
    httpsPort: 443
  });
  controller.shutdown();
  assert.deepEqual(commands, [["tailscale", ["funnel", "status", "--json"]]]);
});

test("FunnelController start and stop keep cached state aligned with Tailscale", () => {
  const commands = [];
  const controller = new FunnelController({
    getProxyPort: () => 8800,
    getHttpsPort: () => 8443,
    runSync: (command, args) => {
      commands.push([command, args]);
      if (args[1] === "status") return statusJson({ httpsPort: 8443 });
      return "";
    }
  });

  assert.equal(controller.start().started, true);
  assert.equal(controller.snapshot.publicBaseUrl, "https://device.tailnet.ts.net:8443");
  assert.equal(controller.stop().started, false);
  assert.equal(controller.snapshot.publicBaseUrl, "http://localhost:8800");
  assert.deepEqual(commands.map(([, args]) => args), [
    ["funnel", "--bg", "--https=8443", "localhost:8800"],
    ["funnel", "status", "--json"],
    ["funnel", "--https=8443", "off"]
  ]);
});

test("FunnelController rejects preserved state it cannot inspect", () => {
  const controller = new FunnelController({
    getProxyPort: () => 8800,
    getHttpsPort: () => 443,
    preserveExisting: true,
    runSync: () => {
      throw new Error("tailscale unavailable");
    }
  });
  assert.throws(() => controller.reconcileOnStartup(), /tailscale unavailable/);
});
