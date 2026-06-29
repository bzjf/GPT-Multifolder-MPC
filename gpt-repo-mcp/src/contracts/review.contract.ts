import { z } from "zod";

export const PlanReviewInputSchema = z.object({
  prompt: z.string().min(1)
});

export const PlanReviewResultSchema = z.object({
  should_ask_clarifying_question: z.boolean(),
  suggested_question: z.string().optional(),
  recommended_next_tools: z.array(z.string()),
  recommended_scope: z.string(),
  estimated_cost: z.enum(["low", "medium", "high"]),
  explicit_full_repo: z.boolean()
});
