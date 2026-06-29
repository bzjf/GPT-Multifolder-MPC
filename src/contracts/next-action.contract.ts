import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const NextActionModeSchema = z.enum(["ship", "cleanup", "plan", "debug", "refactor"]);
export const NextActionHorizonSchema = z.enum(["today", "this_week", "next_milestone"]);
export const NextActionRiskSchema = z.enum(["low", "medium", "high"]);
export const NextActionConfidenceSchema = z.enum(["low", "medium", "high"]);
export const NextActionToolHintSchema = z.enum([
  "repo_project_brief",
  "repo_task_inventory",
  "repo_git_status",
  "repo_git_diff",
  "repo_search",
  "repo_fetch_file",
  "repo_read_many",
  "repo_change_plan",
  "repo_decision_memory"
]);

export const NextActionInputSchema = RepoInputSchema.extend({
  mode: NextActionModeSchema.optional(),
  horizon: NextActionHorizonSchema.optional()
});

export const NextActionResultSchema = z.object({
  recommendation: z.string(),
  rationale: z.array(z.string()),
  suggested_actions: z.array(z.object({
    title: z.string(),
    reason: z.string(),
    tool_hint: NextActionToolHintSchema.optional(),
    risk: NextActionRiskSchema
  })),
  blockers: z.array(z.string()),
  useful_context: z.array(z.object({
    path: z.string(),
    reason: z.string()
  })),
  confidence: NextActionConfidenceSchema,
  warnings: z.array(z.string())
});

export type NextActionInput = z.infer<typeof NextActionInputSchema>;
export type NextActionMode = z.infer<typeof NextActionModeSchema>;
export type NextActionHorizon = z.infer<typeof NextActionHorizonSchema>;
