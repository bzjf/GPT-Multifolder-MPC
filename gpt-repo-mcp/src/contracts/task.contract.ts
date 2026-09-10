import { z } from "zod";
import { GlobScopeSchema } from "./file.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

export const TaskKindSchema = z.enum(["todo", "fixme", "hack", "checkbox", "roadmap"]);

export const TaskInventoryInputSchema = RepoInputSchema
  .merge(GlobScopeSchema)
  .extend({
    labels: z.array(TaskKindSchema).optional().describe("Task marker kinds to return. Omit to include todo, fixme, hack, checkbox, and roadmap. Example: [\"todo\", \"fixme\"]."),
    max_results: z.number().int().positive().optional().describe("Maximum task markers to return on this page. Omit to use the configured search-result limit; larger values are capped."),
    cursor: z.string().optional().describe("Opaque next_cursor from the previous repo_task_inventory page with the same filters. Omit on the first page; never invent or modify it.")
  });

export const TaskInventoryItemSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  kind: TaskKindSchema,
  text: z.string(),
  surrounding_context: z.string().optional()
});

export const TaskInventoryResultSchema = z.object({
  tasks: z.array(TaskInventoryItemSchema),
  matched_count: z.number().int().nonnegative(),
  returned_count: z.number().int().nonnegative(),
  scanned_file_count: z.number().int().nonnegative(),
  scan_complete: z.boolean(),
  truncated: z.boolean(),
  next_cursor: z.string().optional(),
  warnings: z.array(z.string()).default([])
});

export type TaskInventoryInput = z.infer<typeof TaskInventoryInputSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
