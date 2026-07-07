import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const PathInputSchema = z.object({
  path: z.string().min(1)
});

export const GlobScopeSchema = z.object({
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional()
});

export const FetchFileInputSchema = RepoInputSchema.extend({
  path: z.string().min(1).describe("Repo-relative POSIX path to a UTF-8 text file."),
  start_line: z.number().int().positive().optional().describe("First 1-based line to return. Selects streaming line mode."),
  end_line: z.number().int().positive().optional().describe("Last inclusive 1-based line to return."),
  byte_offset: z.number().int().nonnegative().optional().describe("Source byte offset for byte-window mode. UTF-8 boundary adjustment may be reported in warnings."),
  cursor: z.string().min(1).max(4096).optional().describe("Opaque next_cursor returned by a previous call for the same unchanged file."),
  max_bytes: z.number().int().positive().optional().describe("Maximum UTF-8 response bytes for this page, capped by server configuration."),
  override_default_excludes: z.boolean().optional().describe("Read a default-excluded text path when policy allows an explicit override.")
});

export const ReadManyInputSchema = RepoInputSchema.extend({
  paths: z.array(z.string()).optional(),
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional(),
  max_files: z.number().int().positive().optional(),
  max_bytes_per_file: z.number().int().positive().optional(),
  max_total_bytes: z.number().int().positive().optional(),
  cursor: z.string().regex(/^\d+$/).max(32).optional().describe("Zero-based file-list cursor returned by a previous repo_read_many call.")
}).refine((input) => (input.paths?.length ?? 0) > 0 || (input.include_globs?.length ?? 0) > 0, {
  message: "repo_read_many requires paths or include_globs.",
  path: ["paths"]
});

export const FileClassificationSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  is_binary: z.boolean(),
  is_secret_candidate: z.boolean(),
  is_generated: z.boolean()
});

export const FileSummarySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory", "nested_repo", "submodule"]),
  size_bytes: z.number().int().nonnegative().optional()
});

export const FileContentSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  mode: z.enum(["bytes", "lines"]).describe("How this chunk was selected."),
  file_size_bytes: z.number().int().nonnegative().describe("Size of the complete file on disk."),
  returned_bytes: z.number().int().nonnegative().describe("UTF-8 byte length of text returned in this response."),
  size_bytes: z.number().int().nonnegative().describe("Compatibility alias for returned_bytes."),
  sha256: z.string().describe("Compatibility alias for chunk_sha256; this is not a whole-file hash for paged reads."),
  chunk_sha256: z.string().describe("SHA-256 of the redacted text returned in this response."),
  total_lines: z.number().int().nonnegative().optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  byte_start: z.number().int().nonnegative().optional(),
  byte_end: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
  next_cursor: z.string().optional(),
  text: z.string(),
  warnings: z.array(z.string()).default([])
});

export const ReadManyResultSchema = z.object({
  files: z.array(FileContentSchema),
  skipped: z.array(z.object({
    path: z.string(),
    reason: z.string()
  })),
  matched_count: z.number().int().nonnegative(),
  returned_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  next_cursor: z.string().optional()
});
