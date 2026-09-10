import { z } from "zod";
import { GlobScopeSchema } from "./file.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

export const PlanningDepthSchema = z.enum(["quick", "standard", "deep"]);
export const RiskSchema = z.enum(["low", "medium", "high"]);
export const ChangePlanCostSchema = z.enum(["small", "medium", "large"]);

export const ChangePlanInputSchema = RepoInputSchema
  .merge(GlobScopeSchema.pick({ include_globs: true }))
  .extend({
    goal: z.string().min(1).describe("Concise one-sentence planning target. Keep only the essential subsystem, constraint, and intended outcome; omit background narrative and step-by-step instructions. This text directly affects file ranking and generated plan content. Example: \"Clarify grouped edit schema constraints.\""),
    max_files_to_inspect: z.number().int().positive().optional().describe("Maximum ranked files to include in the plan. Omit for the planning_depth default: quick 12, standard 30, or deep 60; the configured server limit still applies."),
    planning_depth: PlanningDepthSchema.optional().describe("Planning breadth: quick inspects up to 12 ranked files, standard up to 30 and is the default, and deep up to 60 before server caps.")
  });

export const ChangePlanResultSchema = z.object({
  goal: z.string(),
  relevant_files: z.array(z.object({
    path: z.string(),
    reason: z.string()
  })),
  proposed_steps: z.array(z.object({
    order: z.number().int().positive(),
    title: z.string(),
    description: z.string(),
    files_likely_touched: z.array(z.string()),
    risk: RiskSchema
  })),
  test_strategy: z.array(z.string()),
  open_questions: z.array(z.string()),
  estimated_cost: ChangePlanCostSchema,
  scan_complete: z.boolean(),
  warnings: z.array(z.string())
});

export type ChangePlanInput = z.infer<typeof ChangePlanInputSchema>;
export type PlanningDepth = z.infer<typeof PlanningDepthSchema>;
