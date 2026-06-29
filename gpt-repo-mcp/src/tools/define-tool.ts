import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeContext } from "../runtime/context.js";
import { createErrorEnvelope } from "../runtime/result-envelope.js";
import { toRepoReaderError } from "../runtime/errors.js";
import { isToolGateRequired, stripToolGate, verifyToolGate } from "../runtime/tool-gate.js";
import { withToolGateCode } from "../contracts/tool-gate.contract.js";
import type { ToolDefinition } from "./catalog.js";

export function registerCatalogTool(server: McpServer, context: RuntimeContext, tool: ToolDefinition): void {
  const inputSchema = isToolGateRequired(tool.name, context)
    ? withToolGateCode(tool.inputSchema)
    : tool.inputSchema;

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: inputSchema.shape,
      outputSchema: tool.outputSchema.shape,
      annotations: tool.annotations
    },
    async (args) => {
      try {
        verifyToolGate(tool.name, args, context);
      } catch (error) {
        return createErrorEnvelope(toRepoReaderError(error));
      }
      return tool.handler(stripToolGate(args), context);
    }
  );
}
