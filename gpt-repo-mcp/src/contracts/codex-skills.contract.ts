import { z } from "zod";

export const CodexSkillSourceSchema = z.enum(["user", "system", "plugin"]);

export const CodexSkillsInputSchema = z.object({
  include_user: z.boolean().optional().describe("Include user skills under CODEX_HOME/skills outside .system. Defaults to true."),
  include_system: z.boolean().optional().describe("Include bundled skills under CODEX_HOME/skills/.system. Defaults to true."),
  include_plugins: z.boolean().optional().describe("Include plugin-provided skills under CODEX_HOME/plugins/cache. Defaults to true."),
  max_results: z.number().int().positive().optional().describe("Maximum skills to return. Defaults to 400 and is capped at 1000.")
});

export const CodexReadSkillInputSchema = z.object({
  name: z.string().min(1).describe("Exact skill frontmatter name returned by codex_list_skills; filesystem paths are not accepted. Example: \"mcp-builder\"."),
  source: CodexSkillSourceSchema.optional().describe("Source filter used only to disambiguate duplicate names: user, system, or plugin. Example: \"user\"."),
  max_bytes: z.number().int().positive().optional().describe("Maximum SKILL.md bytes to return. Defaults to 512000 and is capped at 2000000.")
});

export const CodexSkillSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: CodexSkillSourceSchema,
  skill_file: z.string(),
  directory: z.string()
});

export const CodexSkillsResultSchema = z.object({
  skills: z.array(CodexSkillSummarySchema),
  returned_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: z.array(z.string()).default([])
});

export const CodexReadSkillResultSchema = z.object({
  skill: CodexSkillSummarySchema,
  content: z.string(),
  size_bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: z.array(z.string()).default([])
});

export type CodexSkillsInput = z.infer<typeof CodexSkillsInputSchema>;
export type CodexReadSkillInput = z.infer<typeof CodexReadSkillInputSchema>;
export type CodexSkillSource = z.infer<typeof CodexSkillSourceSchema>;
