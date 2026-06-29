import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const OperationReceiptRefSchema = z.object({
  operation_id: z.string().describe("Stable identifier for the saved local write receipt."),
  path: z.literal(".chatgpt/operations/last-write.json").describe("Repo-relative receipt file path.")
});

const ReceiptCountsSchema = z.object({
  requested: z.number().int().nonnegative().describe("Number of requested write changes in the operation."),
  changed: z.number().int().nonnegative().describe("Number of requested writes that changed file content."),
  created: z.number().int().nonnegative().describe("Number of paths created by the write operation."),
  unchanged: z.number().int().nonnegative().describe("Number of requested writes that were no-ops.")
});

export const OperationReceiptSchema = z.object({
  schema_version: z.literal(1).describe("Receipt schema version."),
  operation_id: z.string().describe("Stable identifier for this local write operation receipt."),
  tool: z.enum(["repo_write_file", "repo_write_changes"]).describe("Write tool that produced the receipt."),
  repo_id: z.string().describe("Repository id used by the write tool."),
  timestamp: z.string().datetime().describe("UTC timestamp when the receipt was written."),
  head_sha_before: z.string().optional().describe("Best-effort git HEAD SHA observed before the write."),
  head_sha_after: z.string().optional().describe("Best-effort git HEAD SHA observed after the write."),
  touched_paths: z.array(z.string()).describe("Repo-relative paths touched by the write operation."),
  changed_paths: z.array(z.string()).describe("Repo-relative paths whose content changed."),
  created_paths: z.array(z.string()).describe("Repo-relative paths created by the write operation."),
  modified_paths: z.array(z.string()).describe("Repo-relative existing paths modified by the write operation."),
  counts: ReceiptCountsSchema.describe("Safe aggregate write operation counts."),
  summary: z.string().describe("Safe content-free summary of the write operation.")
});

export const LastWriteInputSchema = RepoInputSchema;

export const LastWriteResultSchema = z.object({
  ok: z.literal(true).describe("True when the read-only last-write lookup completed."),
  found: z.boolean().describe("Whether a valid last-write receipt was found."),
  receipt: OperationReceiptSchema.optional().describe("Latest safe write receipt when present."),
  next_tool_payloads: z.object({
    repo_git_review: RepoInputSchema.optional().describe("Suggested read-only review payload for the receipt repository.")
  }).describe("Read-only next tool payloads derived from the receipt."),
  warnings: z.array(z.string()).describe("Stable non-fatal warnings from last-write lookup.")
});

export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;
export type OperationReceiptRef = z.infer<typeof OperationReceiptRefSchema>;
export type LastWriteInput = z.infer<typeof LastWriteInputSchema>;
export type LastWriteResult = z.infer<typeof LastWriteResultSchema>;
