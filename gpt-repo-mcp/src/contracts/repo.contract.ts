import { z } from "zod";

export const RepoInputSchema = z.object({
  repo_id: z.string().min(1).describe("Exact approved repository id returned by repo_list_roots, not a filesystem path. Example: \"my-app\".")
});

export const RepoTreeInputSchema = RepoInputSchema.extend({
  path: z.string().optional().describe("Repo-relative POSIX directory to use as the tree root. Omit for the repository root. Example: \"src/services\"."),
  max_depth: z.number().int().positive().optional().describe("Maximum directory depth below path. Omit to use the configured server limit; larger values are capped."),
  page_size: z.number().int().positive().optional().describe("Maximum entries to return on this page. Omit to use the configured server limit; larger values are capped."),
  include_files: z.boolean().optional().describe("Whether to include files as well as directories. Defaults to true."),
  respect_default_excludes: z.boolean().optional().describe("Whether to omit default-excluded paths such as VCS metadata. Defaults to true; set false only for an explicit inspection need."),
  include_generated: z.boolean().optional().describe("Whether to include generated directories such as dist, build, out, and coverage. Defaults to false."),
  include_dependencies: z.boolean().optional().describe("Whether to include dependency directories such as node_modules and vendor. Defaults to false."),
  cursor: z.string().optional().describe("Opaque next_cursor from the previous repo_tree page with the same options. Omit on the first page; never invent or modify it.")
});

export const RepoSummarySchema = z.object({
  repo_id: z.string(),
  display_name: z.string(),
  root: z.string()
});

export const RepoListResultSchema = z.object({
  repos: z.array(RepoSummarySchema)
});
