import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const GitStatusInputSchema = RepoInputSchema;

export const GitDiffInputSchema = RepoInputSchema.extend({
  base: z.string().optional().describe("Second-pass refinement for comparing from a specific base ref. Omit on the first diff call."),
  compare: z.string().optional().describe("Second-pass refinement for comparing to a specific ref. Omit on the first diff call."),
  staged: z.boolean().optional().describe("Second-pass refinement to focus on staged changes only. Omit on the first diff call."),
  unstaged: z.boolean().optional().describe("Second-pass refinement to focus on unstaged changes only. Omit on the first diff call."),
  paths: z.array(z.string()).optional().describe("Preferred selector for explicit repo-relative changed paths. First call repo_git_status, then request diff in small coherent path batches, usually 1-5 files per call. Do not pass every changed path at once. Omit only when status shows very few changed files or the user explicitly requests a whole-repository comparison."),
  max_bytes: z.number().int().positive().optional().describe("Second-pass refinement for the raw diff byte budget. Omit on the first diff call to use the compact configured default (32000 bytes by default). After truncation, first reduce the paths batch; increase max_bytes only when one small batch still needs more content, up to the configured hard limit (512000 bytes by default)."),
  context_lines: z.number().int().min(0).max(20).optional().describe("Second-pass refinement for hunk context when the default diff needs more or less context. Omit on the first diff call.")
});

export const GitStatusResultSchema = z.object({
  branch: z.string(),
  head_sha: z.string(),
  clean: z.boolean(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  files: z.array(z.object({
    path: z.string(),
    original_path: z.string().optional(),
    index: z.string(),
    worktree: z.string()
  }))
});

export const GitDiffResultSchema = z.object({
  base: z.string().optional(),
  compare: z.string().optional(),
  staged: z.boolean().optional(),
  unstaged: z.boolean().optional(),
  files: z.array(z.object({
    path: z.string(),
    original_path: z.string().optional(),
    status: z.string().optional(),
    hunks: z.array(z.string())
  })),
  truncated: z.boolean(),
  warnings: z.array(z.string()).default([])
});
