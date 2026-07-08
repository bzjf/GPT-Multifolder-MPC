import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { toolCatalog } from "./tools/catalog.js";
import { registerCatalogTool } from "./tools/define-tool.js";
import type { RuntimeContext } from "./runtime/context.js";

export { SERVER_INSTRUCTIONS };

export type McpServerOptions = {
  exposeCompatibilityAliases?: boolean;
};

const COMPATIBILITY_ALIASES = new Set([
  "repo_git_stage",
  "repo_git_unstage",
  "repo_git_commit"
]);

export function createMcpServer(context: RuntimeContext, options: McpServerOptions = {}): McpServer {
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

  const exposeCompatibilityAliases = options.exposeCompatibilityAliases
    ?? process.env.GPT_REPO_EXPOSE_COMPAT_ALIASES === "true";
  for (const tool of toolCatalog) {
    if (!exposeCompatibilityAliases && COMPATIBILITY_ALIASES.has(tool.name)) continue;
    registerCatalogTool(server, context, tool);
  }

  return server;
}
