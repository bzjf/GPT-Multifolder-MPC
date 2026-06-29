import { z } from "zod";

export const CodexSkillSourceSchema = z.enum(["user", "system", "plugin"]);

export const CodexSkillsInputSchema = z.object({
  include_user: z.boolean().optional().describe("Include skills under CODEX_HOME/skills outside .system."),
  include_system: z.boolean().optional().describe("Include bundled system skills under CODEX_HOME/skills/.system."),
  include_plugins: z.boolean().optional().describe("Include plugin-provided skills under CODEX_HOME/plugins/cache."),
  max_results: z.number().int().positive().optional().describe("Maximum number of skills to return before truncating.")
});

export const CodexReadSkillInputSchema = z.object({
  name: z.string().min(1).describe("Skill frontmatter name from codex_list_skills. Paths are not accepted."),
  source: CodexSkillSourceSchema.optional().describe("Optional source filter when more than one skill has the same name."),
  max_bytes: z.number().int().positive().optional().describe("Maximum SKILL.md bytes to return before truncating.")
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
