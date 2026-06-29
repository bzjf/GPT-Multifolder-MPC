import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const ProjectBriefIncludeSchema = z.enum(["package", "readme", "architecture", "scripts", "recent_git", "todos"]);

export const ProjectBriefInputSchema = RepoInputSchema.extend({
  include: z.array(ProjectBriefIncludeSchema).optional()
});

export const ProjectBriefResultSchema = z.object({
  repo: z.object({
    repo_id: z.string(),
    display_name: z.string()
  }),
  project_type: z.string().optional(),
  languages: z.array(z.string()),
  package_managers: z.array(z.string()),
  scripts: z.array(z.object({
    name: z.string(),
    command: z.string()
  })),
  key_docs: z.array(z.object({
    path: z.string(),
    summary: z.string()
  })),
  likely_entrypoints: z.array(z.string()),
  test_commands: z.array(z.string()),
  truncated: z.boolean(),
  warnings: z.array(z.string())
});

export type ProjectBriefInclude = z.infer<typeof ProjectBriefIncludeSchema>;
export type ProjectBriefInput = z.infer<typeof ProjectBriefInputSchema>;
