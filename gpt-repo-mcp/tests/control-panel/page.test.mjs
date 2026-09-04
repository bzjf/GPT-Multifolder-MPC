import assert from "node:assert/strict";
import test from "node:test";
import { controlPanelHtml } from "../../../scripts/control-panel/page.mjs";

test("control panel page exposes the local MCP tester contract", () => {
  for (const id of [
    "mcpTestInstance",
    "mcpInitializeBtn",
    "mcpListToolsBtn",
    "mcpToolName",
    "mcpCallToolBtn",
    "mcpToolArguments",
    "mcpTestOutput"
  ]) {
    assert.match(controlPanelHtml, new RegExp(`id=["']${id}["']`));
  }
  assert.match(controlPanelHtml, /\/api\/mcp-test\//);
  assert.doesNotMatch(controlPanelHtml, /useFunnel/);
});

test("control panel page distinguishes process startup from MCP readiness", () => {
  assert.match(controlPanelHtml, /item\.processRunning/);
  assert.match(controlPanelHtml, /item\.mcpReady/);
  assert.match(controlPanelHtml, /启动中/);
  assert.match(controlPanelHtml, /已就绪/);
});
