import { z } from "zod";
import { GitReviewResultSchema } from "./git-review.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

const NonEmptyStringSchema = z.string().min(1);
const RepoPathListSchema = z.array(z.string().min(1)).default([]);
const CodexRunIdSchema = z.string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z-[a-z0-9][a-z0-9-]{0,79}$/)
  .describe("Stable repo-local Codex run id. Generated when omitted.");

export const CodexTaskInputSchema = RepoInputSchema.extend({
  title: NonEmptyStringSchema.describe("Short human-readable task title used in the prompt and generated run id."),
  objective: NonEmptyStringSchema.describe("Concrete implementation objective for Codex."),
  context_summary: z.string().min(1).optional().describe("Short context summary ChatGPT wants Codex to know before editing."),
  inspect_first: RepoPathListSchema.describe("Repo-relative files or globs Codex should inspect before editing."),
  allowed_paths: RepoPathListSchema.describe("Repo-relative files or globs Codex may edit."),
  forbidden_paths: RepoPathListSchema.describe("Repo-relative files or globs Codex must not edit."),
  implementation_scope: z.object({
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([])
  }).optional().describe("Explicit implementation boundaries."),
  acceptance_criteria: z.array(z.string().min(1)).default([]).describe("Criteria Codex should satisfy before finishing."),
  verification_commands: z.array(z.string().min(1)).default([]).describe("Commands Codex should run when feasible and report in RESULT.md."),
  run_id: CodexRunIdSchema.optional()
});

export const CodexTaskWriteInputSchema = CodexTaskInputSchema.extend({
  dry_run: z.boolean().optional().describe("For repo_write_codex_task only: render and validate without writing files."),
  reason: z.string().min(1).optional().describe("Short audit reason for writing the task locally.")
});

export const CodexTaskResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  run_id: CodexRunIdSchema,
  prompt_path: z.string(),
  result_path: z.string(),
  manifest_path: z.string(),
  prompt_markdown: z.string(),
  codex_user_prompt: z.string(),
  next_steps: z.array(z.string()),
  warnings: z.array(z.string())
});

export const CodexTaskWriteResultSchema = CodexTaskResultSchema.extend({
  dry_run: z.boolean(),
  written_paths: z.array(z.string())
});

export const CodexReviewInputSchema = RepoInputSchema.extend({
  run_id: CodexRunIdSchema.describe("Codex run id under .chatgpt/codex-runs."),
  max_files: z.number().int().positive().optional().describe("Maximum git diff files to summarize.")
});

export const CodexParsedResultSchema = z.object({
  status: z.enum(["completed", "blocked", "unknown"]),
  summary: z.string(),
  changed_files: z.array(z.string()),
  commands_run: z.array(z.string()),
  tests: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  blockers: z.array(z.string()),
  followups: z.array(z.string()),
  raw_text: z.string()
});

export const CodexReviewResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  run_id: CodexRunIdSchema,
  result_path: z.string(),
  result_found: z.boolean(),
  codex_result: CodexParsedResultSchema.optional(),
  git_review: GitReviewResultSchema.optional(),
  next_tool_payloads: GitReviewResultSchema.shape.next_tool_payloads.optional(),
  next_steps: z.array(z.string()),
  warnings: z.array(z.string())
});

export type CodexTask = z.output<typeof CodexTaskInputSchema>;
export type CodexTaskInput = z.input<typeof CodexTaskInputSchema>;
export type CodexTaskWrite = z.output<typeof CodexTaskWriteInputSchema>;
export type CodexTaskWriteInput = z.input<typeof CodexTaskWriteInputSchema>;
export type CodexTaskResult = z.infer<typeof CodexTaskResultSchema>;
export type CodexTaskWriteResult = z.infer<typeof CodexTaskWriteResultSchema>;
export type CodexReviewInput = z.infer<typeof CodexReviewInputSchema>;
export type CodexParsedResult = z.infer<typeof CodexParsedResultSchema>;
export type CodexReviewResult = z.infer<typeof CodexReviewResultSchema>;
