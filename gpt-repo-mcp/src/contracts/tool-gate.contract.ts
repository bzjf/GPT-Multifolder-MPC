import { z } from "zod";

export const ToolGateCodeFieldSchema = z.string().min(1).describe(
  "One-shot MCP server access code printed by startup script. Required for protected tools; codex_list_skills is exempt."
);

export const ToolGateInputSchema = z.object({
  mcp_code: ToolGateCodeFieldSchema
});

export function withToolGateCode<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.extend({ mcp_code: ToolGateCodeFieldSchema });
}

export type ToolGateInput = z.infer<typeof ToolGateInputSchema>;
