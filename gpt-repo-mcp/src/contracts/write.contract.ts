import { z } from "zod";
import { OperationReceiptRefSchema } from "./operation-receipt.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

export const WriteFileActionSchema = z.enum(["replace_lines", "insert_before_line", "insert_after_line", "write", "replace", "append", "prepend", "insert_before", "insert_after"]);
export const WriteGroupedEditActionSchema = z.enum(["replace_lines", "insert_before_line", "insert_after_line", "replace", "insert_before", "insert_after"]);
export const WriteChangeTypeSchema = z.enum(["replace_lines", "insert_before_line", "insert_after_line", "edit", "write", "replace", "append", "prepend", "insert_before", "insert_after"]);

export const WriteSimpleChangeSchema = z.object({
  type: WriteFileActionSchema.describe("Per-file operation. For an existing file whose current lines were read, use replace_lines, insert_before_line, or insert_after_line. Use write only for creation or intentional full-file replacement; exact-text operations are fallback-only."),
  path: z.string().min(1).describe("Repo-relative POSIX path to write or edit. Absolute paths, traversal, symlink escapes, denied globs, and hard-risk secret paths are rejected."),
  content: z.string().optional().describe("UTF-8 text to write, append, prepend, insert, or replace whole lines. Required for write, append, prepend, insert_before, insert_after, replace_lines, insert_before_line, and insert_after_line."),
  find: z.string().min(1).optional().describe("Fallback exact-text anchor for replace, insert_before, and insert_after only when current line numbers are unavailable. The text must appear exactly once."),
  replace: z.string().optional().describe("Replacement text for replace. Required when type is replace."),
  start_line: z.number().int().positive().optional().describe("Exact 1-based target line copied unchanged from repo_fetch_file or repo_search for replace_lines, insert_before_line, and insert_after_line."),
  end_line: z.number().int().positive().optional().describe("Inclusive 1-based final line for replace_lines, in the same pre-edit file snapshot. Defaults to start_line.")
});

export const WriteGroupedEditItemSchema = z.object({
  type: WriteGroupedEditActionSchema.describe("Edit operation. Prefer line-number whole-line actions. A grouped edit must use either line-number actions or exact-text actions, never both coordinate systems."),
  find: z.string().min(1).optional().describe("Fallback exact-text anchor when line numbers are unavailable. The text must appear exactly once at this edit's turn."),
  replace: z.string().optional().describe("Replacement text for replace grouped edits."),
  content: z.string().optional().describe("Text to insert or use as whole-line replacement for grouped edits."),
  start_line: z.number().int().positive().optional().describe("Exact 1-based target line in the original pre-edit file snapshot for grouped replace_lines, insert_before_line, and insert_after_line."),
  end_line: z.number().int().positive().optional().describe("Inclusive 1-based final line in the original pre-edit file snapshot for grouped replace_lines. Defaults to start_line.")
});

export const WriteGroupedEditChangeSchema = z.object({
  type: z.enum(["edit"]).describe("Grouped same-file edits. Use line-number whole-line edits after reading targeted ranges. Every line coordinate refers to the original pre-edit snapshot; exact-text edits are fallback-only and cannot be mixed with line edits."),
  path: z.string().min(1).describe("Repo-relative POSIX path to an existing UTF-8 text file. Absolute paths, traversal, symlink escapes, denied globs, and hard-risk secret paths are rejected."),
  edits: z.array(WriteGroupedEditItemSchema).min(1).max(25).describe("Same-file edits. Line-number edits all reference the original pre-edit snapshot and are safely applied bottom-up; they must not overlap. Exact-text edits remain ordered and cannot be mixed with line-number edits.")
});

export const WriteChangeSchema = z.union([WriteSimpleChangeSchema, WriteGroupedEditChangeSchema]);

export const WriteFileInputSchema = RepoInputSchema.extend({
  path: z.string().min(1).describe("Repo-relative POSIX path to write or edit. Absolute paths, traversal, symlink escapes, denied globs, and secret-looking paths are rejected."),
  action: WriteFileActionSchema.optional().describe("Single-file operation. For an existing file whose current lines were read, use replace_lines, insert_before_line, or insert_after_line. Omission defaults to write and is intended only for creation or intentional full-file replacement."),
  content: z.string().optional().describe("UTF-8 text to write, append, prepend, insert, or replace whole lines. Required for write, append, prepend, insert_before, insert_after, replace_lines, insert_before_line, and insert_after_line."),
  find: z.string().min(1).optional().describe("Fallback exact-text anchor for replace, insert_before, and insert_after only when current line numbers are unavailable. The text must appear exactly once."),
  replace: z.string().optional().describe("Replacement text for replace. Required when action is replace."),
  start_line: z.number().int().positive().optional().describe("Exact 1-based target line copied unchanged from repo_fetch_file or repo_search for replace_lines, insert_before_line, and insert_after_line."),
  end_line: z.number().int().positive().optional().describe("Inclusive 1-based final line for replace_lines, in the same file snapshot. Defaults to start_line."),
  create_dirs: z.boolean().optional().describe("Create missing parent directories inside the approved repo root when policy allows the target path."),
  dry_run: z.boolean().optional().describe("Validate policy, path, size, and content checks and compute the result without writing to disk."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the write request, useful for audit context.")
});

export const WriteFileResultSchema = z.object({
  ok: z.literal(true).describe("True when the write request completed or dry-run validation succeeded."),
  path: z.string().describe("Normalized repo-relative path that was validated."),
  action: WriteFileActionSchema.describe("Single-file operation that was performed or dry-run validated."),
  dry_run: z.boolean().describe("Whether the request was validation-only and did not write to disk."),
  changed: z.boolean().describe("Whether the resulting file content differs from the previous content."),
  created: z.boolean().describe("Whether the target file did not exist before the operation."),
  bytes_written: z.number().int().nonnegative().describe("Number of bytes in the resulting file content written to disk. Dry runs and no-op writes return 0."),
  old_sha256: z.string().optional().describe("SHA-256 of the previous file content when the target existed."),
  new_sha256: z.string().optional().describe("SHA-256 of the resulting file content."),
  summary: z.string().describe("Short human-readable summary of the operation result."),
  warnings: z.array(z.string()).describe("Non-fatal warnings produced by the write service."),
  operation_receipt: OperationReceiptRefSchema.optional().describe("Local last-write receipt metadata when an actual changed write saved a receipt.")
});

export const WriteChangesInputSchema = RepoInputSchema.extend({
  changes: z.array(WriteChangeSchema).min(1).max(25).describe("Ordered edit pack. Existing files with known line numbers should use line-number actions, not patch-shaped exact-text replacements. Each path may appear at most once; combine same-file edits into one type=edit change. Grouped line coordinates all refer to the original pre-edit snapshot and must not overlap. All changes are validated before writes begin; no git stage or commit is performed."),
  dry_run: z.boolean().optional().describe("Validate and preview the edit pack without writing files. Dry run is optional and is not required before applying changes."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the edit-pack request, useful for audit context.")
});

export const WriteChangesFileResultSchema = z.object({
  path: z.string().describe("Normalized repo-relative path that was validated."),
  type: WriteChangeTypeSchema.describe("Per-file operation that was performed or dry-run validated."),
  changed: z.boolean().describe("Whether the resulting file content differs from the previous content."),
  created: z.boolean().describe("Whether the target file did not exist before the operation."),
  bytes_written: z.number().int().nonnegative().describe("Number of bytes in the resulting file content written to disk. Dry runs and no-op writes return 0."),
  old_sha256: z.string().optional().describe("SHA-256 of the previous file content when the target existed."),
  new_sha256: z.string().optional().describe("SHA-256 of the resulting file content."),
  summary: z.string().describe("Short human-readable summary of the per-file operation result.")
});

export const WriteChangesResultSchema = z.object({
  ok: z.literal(true).describe("True when the edit pack completed or dry-run validation succeeded."),
  dry_run: z.boolean().describe("Whether the request was validation-only and did not write files."),
  changed_paths: z.array(z.string()).describe("Unique repo-relative paths whose resulting content differs from the previous content, in first-change order."),
  files: z.array(WriteChangesFileResultSchema).describe("Per-change write or edit results in request order."),
  counts: z.object({
    requested: z.number().int().nonnegative().describe("Number of requested changes."),
    changed: z.number().int().nonnegative().describe("Number of changes that would modify or did modify file content."),
    created: z.number().int().nonnegative().describe("Number of changes that would create or did create a new file."),
    unchanged: z.number().int().nonnegative().describe("Number of requested changes that were no-ops.")
  }).describe("Aggregate edit-pack counts."),
  summary: z.string().describe("Short human-readable summary of the edit-pack result."),
  warnings: z.array(z.string()).describe("Non-fatal warnings produced by the write-changes service."),
  next_steps: z.array(z.string()).describe("Recommended review and recovery workflow steps after applying the edit pack."),
  operation_receipt: OperationReceiptRefSchema.optional().describe("Local last-write receipt metadata when an actual changed edit pack saved a receipt.")
});

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;
export type WriteFileResult = z.infer<typeof WriteFileResultSchema>;
export type WriteSimpleChange = z.infer<typeof WriteSimpleChangeSchema>;
export type WriteGroupedEditItem = z.infer<typeof WriteGroupedEditItemSchema>;
export type WriteGroupedEditChange = z.infer<typeof WriteGroupedEditChangeSchema>;
export type WriteChange = z.infer<typeof WriteChangeSchema>;
export type WriteChangesInput = z.infer<typeof WriteChangesInputSchema>;
export type WriteChangesFileResult = z.infer<typeof WriteChangesFileResultSchema>;
export type WriteChangesResult = z.infer<typeof WriteChangesResultSchema>;
