import { timingSafeEqual } from "node:crypto";
import type { RuntimeContext } from "./context.js";
import { RepoReaderError } from "./errors.js";

export const TOOL_GATE_FIELD = "mcp_code";

const PUBLIC_TOOL_NAMES = new Set<string>([
  "codex_list_skills"
]);

export function isToolGateRequired(toolName: string, context: RuntimeContext): boolean {
  return Boolean(readExpectedCode(context)) && !PUBLIC_TOOL_NAMES.has(toolName);
}

export function verifyToolGate(toolName: string, input: unknown, context: RuntimeContext): void {
  const expected = readExpectedCode(context);
  if (!expected || PUBLIC_TOOL_NAMES.has(toolName)) {
    return;
  }

  const supplied = readGateCode(input);
  if (!supplied) {
    throw new RepoReaderError("ACCESS_CODE_REQUIRED", `MCP access code required for ${toolName}.`);
  }

  if (!constantTimeEqual(supplied, expected)) {
    throw new RepoReaderError("ACCESS_CODE_INVALID", "Invalid MCP access code.");
  }
}

export function stripToolGate(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const { [TOOL_GATE_FIELD]: _ignored, ...rest } = input as Record<string, unknown>;
  return rest;
}

function readExpectedCode(context: RuntimeContext): string | undefined {
  return context.toolGateCode ?? process.env.GPT_REPO_TOOL_GATE_CODE;
}

function readGateCode(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[TOOL_GATE_FIELD];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
