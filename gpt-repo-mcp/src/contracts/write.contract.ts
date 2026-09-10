import { z } from "zod";
import { OperationReceiptRefSchema } from "./operation-receipt.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

export const WriteFileActionSchema = z.enum(["replace_lines", "insert_before_line", "insert_after_line", "write", "replace", "append", "prepend", "insert_before", "insert_after"]);
export const WriteGroupedEditActionSchema = z.enum(["replace_lines", "insert_before_line", "insert_after_line", "replace", "insert_before", "insert_after"]);
export const WriteChangeTypeSchema = z.enum(["replace_lines", "insert_before_line", "insert_after_line", "edit", "write", "replace", "append", "prepend", "insert_before", "insert_after"]);

const HIDDEN_ANCHOR_ACTIONS = ["replace", "insert_before", "insert_after"] as const;

export const WriteFileToolActionSchema = WriteFileActionSchema.exclude(HIDDEN_ANCHOR_ACTIONS);
export const WriteGroupedEditToolActionSchema = WriteGroupedEditActionSchema.exclude(HIDDEN_ANCHOR_ACTIONS);

export const WriteSimpleChangeSchema = z.object({
  type: WriteFileActionSchema.describe("Per-file operation. For an existing file whose current lines were read, use replace_lines, insert_before_line, or insert_after_line. Use write only for creation or intentional full-file replacement; exact-text operations are fallback-only."),
  path: z.string().min(1).describe("Repo-relative POSIX path to write or edit. Absolute paths, traversal, symlink escapes, denied globs, and hard-risk secret paths are rejected."),
  content: z.string().optional().describe("UTF-8 text to write, append, prepend, insert, or replace whole lines. Required for write, append, prepend, insert_before, insert_after, replace_lines, insert_before_line, and insert_after_line."),
  find: z.string().min(1).optional().describe("Fallback exact-text anchor for replace, insert_before, and insert_after only when current line numbers are unavailable. The text must appear exactly once."),
  replace: z.string().optional().describe("Replacement text for replace. Required when type is replace."),
  start_line: z.number().int().positive().optional().describe("Exact 1-based target line copied unchanged from a read performed after the last successful write to this file. Any coordinate obtained before that write is stale; re-read instead of manually offsetting old line numbers."),
  end_line: z.number().int().positive().optional().describe("Inclusive 1-based final line for replace_lines. It must come from the same fresh file snapshot as start_line and becomes stale after any successful write changes this file. Defaults to start_line.")
});

const WriteGroupedReplaceLinesItemSchema = z.object({
  type: z.literal("replace_lines").describe("Replace one inclusive range of whole lines in the original pre-edit file snapshot."),
  start_line: z.number().int().positive().describe("Required 1-based first line in the original pre-edit file snapshot. It must come from a read performed after the last successful write to this file; earlier coordinates are stale."),
  end_line: z.number().int().positive().optional().describe("Inclusive 1-based final line in the original pre-edit file snapshot. It must come from the same read as start_line and becomes stale after any successful write changes this file. Defaults to start_line and must not be less than start_line."),
  content: z.string().describe("Required replacement text. Its line endings are normalized to the existing file style.")
});

const WriteGroupedInsertBeforeLineItemSchema = z.object({
  type: z.literal("insert_before_line").describe("Insert text immediately before one line in the original pre-edit file snapshot."),
  start_line: z.number().int().positive().describe("Required 1-based anchor line in the original pre-edit file snapshot. It must come from a read performed after the last successful write to this file; earlier coordinates are stale."),
  content: z.string().describe("Required text to insert. Its line endings are normalized to the existing file style.")
});

const WriteGroupedInsertAfterLineItemSchema = z.object({
  type: z.literal("insert_after_line").describe("Insert text immediately after one line in the original pre-edit file snapshot."),
  start_line: z.number().int().positive().describe("Required 1-based anchor line in the original pre-edit file snapshot. It must come from a read performed after the last successful write to this file; earlier coordinates are stale."),
  content: z.string().describe("Required text to insert. Its line endings are normalized to the existing file style.")
});

export const WriteGroupedLineEditItemSchema = z.discriminatedUnion("type", [
  WriteGroupedReplaceLinesItemSchema,
  WriteGroupedInsertBeforeLineItemSchema,
  WriteGroupedInsertAfterLineItemSchema
]).describe("One child edit in a line-edit group. Closed allowlist: type must be exactly replace_lines, insert_before_line, or insert_after_line. Any combination of those three types may be bundled in one group; no other child type is valid. Original target lines or ranges must not overlap.");

export const WriteGroupedEditItemSchema = z.object({
  type: WriteGroupedEditActionSchema.describe("Internal grouped edit operation. A group uses either line-number actions or exact-text actions; the two coordinate systems cannot be mixed."),
  find: z.string().min(1).optional().describe("Required exact-text anchor for internal replace, insert_before, and insert_after actions. It must appear exactly once at this edit's turn."),
  replace: z.string().optional().describe("Required replacement text for an internal replace action."),
  content: z.string().optional().describe("Required text for line replacements and insertions, or internal exact-text insertions."),
  start_line: z.number().int().positive().optional().describe("Required 1-based target line in the original pre-edit file snapshot for line-number actions."),
  end_line: z.number().int().positive().optional().describe("Inclusive final line for replace_lines only. Defaults to start_line and must not be less than start_line.")
});

const groupedEditPathSchema = z.string().min(1).describe("The one repo-relative POSIX path targeted by every item in this group. It must be an existing UTF-8 text file. A group cannot span files, create a file, or also use another top-level change for this path.");

export const WriteGroupedEditChangeSchema = z.object({
  type: z.literal("edit").describe("Internal grouped edits for one existing file, using one coordinate system for the entire group."),
  path: groupedEditPathSchema,
  edits: z.array(WriteGroupedEditItemSchema).min(1).max(25).describe("All edits target this group's single path. Line-number actions may be mixed with each other but cannot overlap. Internal exact-text actions may be mixed with each other and run in order. Line-number and exact-text actions cannot appear in the same group.")
});

export const WriteGroupedLineEditChangeSchema = z.object({
  type: z.literal("edit").describe("Top-level marker for grouping multiple non-overlapping line-number edits for one existing file. Do not put another type=edit item inside edits."),
  path: groupedEditPathSchema,
  edits: z.array(WriteGroupedLineEditItemSchema).min(1).max(25).describe("One to 25 child edits for this group's single path. Before writing, include as many currently known, safely planned, non-overlapping edits from the current file snapshot as possible. Do not split known edits into serial write-and-re-read calls merely to recalculate shifted line numbers. Allowed child type values are exactly: replace_lines, insert_before_line, insert_after_line. Example child: {type: \"insert_after_line\", start_line: 12, content: \"...\"}. These three types may be mixed. Forbidden child types include write, append, prepend, replace, insert_before, insert_after, and edit. All coordinates refer to the same original pre-edit snapshot. The server applies edits bottom-up; no two items may target the same original line or overlapping ranges, including two insertions anchored to the same line. After this request successfully changes the file, re-read before a later line-number write only for work that could not be safely planned from the original snapshot or when verification finds a new issue; never offset stale coordinates manually.")
});

export const WriteChangeSchema = z.union([WriteSimpleChangeSchema, WriteGroupedEditChangeSchema]);

export const WriteFileInputSchema = RepoInputSchema.extend({
  path: z.string().min(1).describe("Repo-relative POSIX path to write or edit. Absolute paths, traversal, symlink escapes, denied globs, and secret-looking paths are rejected."),
  action: WriteFileActionSchema.optional().describe("Single-file operation. For an existing file whose current lines were read, use replace_lines, insert_before_line, or insert_after_line. Omission defaults to write and is intended only for creation or intentional full-file replacement."),
  content: z.string().optional().describe("UTF-8 text to write, append, prepend, insert, or replace whole lines. Required for write, append, prepend, insert_before, insert_after, replace_lines, insert_before_line, and insert_after_line."),
  find: z.string().min(1).optional().describe("Fallback exact-text anchor for replace, insert_before, and insert_after only when current line numbers are unavailable. The text must appear exactly once."),
  replace: z.string().optional().describe("Replacement text for replace. Required when action is replace."),
  start_line: z.number().int().positive().optional().describe("Exact 1-based target line copied unchanged from a read performed after the last successful write to this file. Any coordinate obtained before that write is stale; re-read instead of manually offsetting old line numbers."),
  end_line: z.number().int().positive().optional().describe("Inclusive 1-based final line for replace_lines. It must come from the same fresh file snapshot as start_line and becomes stale after any successful write changes this file. Defaults to start_line."),
  create_dirs: z.boolean().optional().describe("Create missing parent directories inside the approved repo root when policy allows the target path."),
  dry_run: z.boolean().optional().describe("Validate policy, path, size, and content checks and compute the result without writing to disk."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the write request, useful for audit context.")
});

export const WriteFileToolInputSchema = WriteFileInputSchema.extend({
  action: WriteFileToolActionSchema.optional().describe("Single-file operation exposed over MCP. For an existing file whose current lines were read, use replace_lines, insert_before_line, or insert_after_line. Example: action=replace_lines with start_line=10, end_line=12, and content set to the replacement lines. After any successful write changes this file, discard all earlier line coordinates and re-read before another line-number write; never manually offset stale line numbers. Omission defaults to write and is intended only for creation or intentional full-file replacement.")
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

const WriteSimpleToolChangeSchema = WriteSimpleChangeSchema.extend({
  type: WriteFileToolActionSchema.describe("Per-file operation exposed over MCP. For an existing file whose current lines were read, use replace_lines, insert_before_line, or insert_after_line. After a successful write changes this file, re-read it before using line coordinates in a later write call; old coordinates are stale and must not be manually offset. Use write only for creation or intentional full-file replacement.")
});

const WriteGroupedEditToolChangeSchema = WriteGroupedLineEditChangeSchema.describe("MCP grouped edit for one existing UTF-8 text file. The edits array has a closed child-type allowlist: replace_lines, insert_before_line, and insert_after_line only; any combination of those three may be bundled. Do not include write, append, prepend, replace, insert_before, insert_after, nested edit groups, file creation, or another path. All coordinates come from one original pre-edit snapshot and cannot overlap. Re-read after a successful write before using line numbers again.");

const WriteToolChangeSchema = z.union([WriteSimpleToolChangeSchema, WriteGroupedEditToolChangeSchema]);

export const WriteChangesToolInputSchema = WriteChangesInputSchema.extend({
  changes: z.array(WriteToolChangeSchema).min(1).max(25).describe("Ordered edit pack exposed over MCP. Each path may appear at most once. For multiple line edits to one existing file, use one top-level type=edit change and include as many currently known, safely planned, non-overlapping edits from the current snapshot as possible, up to 25. These are line-number actions. Do not issue one known edit at a time with a re-read between writes merely to shift line coordinates. Inside edits, the only valid child types are replace_lines, insert_before_line, and insert_after_line; any combination of those three may be bundled. Never put write, append, prepend, replace, insert_before, insert_after, another edit group, file creation, or a second path inside edits. Keep write, append, and prepend as standalone top-level changes; convert append/prepend intent to a grouped line insertion when practical. Every grouped coordinate refers to the same original pre-edit snapshot, and no two items may target the same line or overlapping ranges. After this request successfully changes a file, discard every coordinate from earlier reads. Re-read before another line-number write only for work that could not be safely planned in the original group or when verification finds a new issue; never manually offset stale line numbers. All changes are validated before writes begin; no git stage or commit is performed.")
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
