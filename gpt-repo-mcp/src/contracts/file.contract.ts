import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const PathInputSchema = z.object({
  path: z.string().min(1)
});

export const GlobScopeSchema = z.object({
  include_globs: z.array(z.string()).optional().describe("Optional repo-relative POSIX globs limiting files considered. Example: [\"src/**/*.ts\"]."),
  exclude_globs: z.array(z.string()).optional().describe("Optional repo-relative POSIX globs removed from consideration. Example: [\"**/*.generated.ts\", \"fixtures/**\"].")
});

export const FetchFileInputSchema = RepoInputSchema.extend({
  path: z.string().min(1).describe("Repo-relative POSIX path to exactly one UTF-8 text file. For two or more files, use repo_read_many. Example: \"src/server.ts\"."),
  start_line: z.number().int().positive().optional().describe("First 1-based line to return; selects line mode. Example: 120. May be combined with end_line, but not with byte_offset or cursor."),
  end_line: z.number().int().positive().optional().describe("Last inclusive 1-based line to return; start_line defaults to 1 when omitted. Must be at least start_line and cannot be combined with byte_offset or cursor."),
  byte_offset: z.number().int().nonnegative().optional().describe("Zero-based source byte offset for byte mode. Do not combine with start_line, end_line, or cursor; UTF-8 boundary adjustment may be reported in warnings."),
  cursor: z.string().min(1).max(4096).optional().describe("Opaque next_cursor from the previous call for the same unchanged file. Use it alone with path and optional max_bytes; never combine it with line or byte selectors, invent it, or modify it."),
  max_bytes: z.number().int().positive().optional().describe("Maximum UTF-8 response bytes for this page. Omit to use the configured per-file limit; larger values are capped."),
  override_default_excludes: z.boolean().optional().describe("Set true only to read a default-excluded text path when repository policy permits an explicit override. Defaults to false.")
});

export const ReadManyInputSchema = RepoInputSchema.extend({
  paths: z.array(z.string()).optional().describe("Explicit repo-relative POSIX file paths to read together. Prefer this after repo_search returns multiple likely files. Example: [\"src/server.ts\", \"src/register.ts\"]."),
  include_globs: z.array(z.string()).optional().describe("Optional repo-relative POSIX globs used to discover files when exact paths are not all known. Example: [\"src/contracts/*.ts\"]."),
  exclude_globs: z.array(z.string()).optional().describe("Optional repo-relative POSIX globs removed from paths and include_globs results. Example: [\"**/*.generated.ts\"]."),
  max_files: z.number().int().positive().optional().describe("Maximum files to return in one batch, capped by server configuration."),
  max_bytes_per_file: z.number().int().positive().optional().describe("Maximum bytes per returned file chunk, capped by server configuration."),
  max_total_bytes: z.number().int().positive().optional().describe("Maximum total bytes across the batch, capped by server configuration."),
  cursor: z.string().regex(/^\d+$/).max(32).optional().describe("Opaque next_cursor returned by the previous repo_read_many page with the same paths and globs. Omit on the first page; never invent or modify it.")
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
  start_line: z.number().int().positive().optional().describe("First returned 1-based line. Use this coordinate unchanged for subsequent line-number write actions."),
  end_line: z.number().int().positive().optional().describe("Last returned 1-based line, inclusive. A trailing newline never creates an additional editable line."),
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
