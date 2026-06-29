import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { toolCatalog } from "./tools/catalog.js";
import { registerCatalogTool } from "./tools/define-tool.js";
import type { RuntimeContext } from "./runtime/context.js";

export { SERVER_INSTRUCTIONS };

export function createMcpServer(context: RuntimeContext): McpServer {
  const server = new McpServer(
    {
      name: "gpt-repo-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: SERVER_INSTRUCTIONS
    }
  );

  for (const tool of toolCatalog) {
    registerCatalogTool(server, context, tool);
  }

  return server;
}
