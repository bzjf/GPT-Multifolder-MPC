import { z } from "zod";
import { FileContentSchema, GlobScopeSchema, ReadManyInputSchema } from "./file.contract.js";
import { RepoInputSchema } from "./repo.contract.js";
import { SearchResultSchema } from "./search.contract.js";

export const EditContextInputSchema = RepoInputSchema
  .merge(GlobScopeSchema)
  .extend({
    goal: z.string().min(1).describe("Short description of the edit or bugfix the caller is preparing."),
    search_queries: z.array(z.string().min(1)).max(10).optional().describe("Exact identifiers, error text, function names, or file words to search before reading files. Omit only when known_paths or include_globs are enough."),
    known_paths: z.array(z.string().min(1)).max(50).optional().describe("Repo-relative POSIX files already known to be relevant. These are read before search-derived candidates."),
    max_search_results_per_query: z.number().int().positive().optional().describe("Maximum search hits to keep per query before selecting candidate files, capped by the server max_search_results limit."),
    max_files_to_read: z.number().int().positive().optional().describe("Maximum candidate files to read in the bundled repo_read_many step, capped by the server max_files limit."),
    max_bytes_per_file: z.number().int().positive().optional().describe("Per-file read budget for bundled file contents, capped by server configuration."),
    max_total_bytes: z.number().int().positive().optional().describe("Total read budget for bundled file contents, capped by server configuration."),
    context_lines: z.number().int().min(0).max(5).optional().describe("Search context lines per match. Keep low because file contents are read separately.")
  });

export const EditContextSearchSchema = z.object({
  query: z.string().describe("Search query that produced this result set."),
  results: z.array(SearchResultSchema).describe("Bounded search hits for this query."),
  matched_count: z.number().int().nonnegative().describe("Number of matches found or lower-bound count when scan_complete is false."),
  returned_count: z.number().int().nonnegative().describe("Number of search hits returned for this query."),
  scan_complete: z.boolean().describe("Whether the search backend completed the scan for this query."),
  truncated: z.boolean().describe("Whether more search hits are available for this query."),
  warnings: z.array(z.string()).default([]).describe("Search warnings such as backend fallback or lower-bound counts.")
});

export const EditContextCandidateSchema = z.object({
  path: z.string().describe("Repo-relative POSIX candidate file path."),
  reason: z.string().describe("Why this path was selected for edit context."),
  source_queries: z.array(z.string()).default([]).describe("Search queries that matched this file.")
});

export const EditContextResultSchema = z.object({
  repo_id: z.string().describe("Approved repository id used for this edit context."),
  goal: z.string().describe("Caller-provided edit or bugfix goal."),
  head_sha: z.string().optional().describe("Current git HEAD SHA when available."),
  searches: z.array(EditContextSearchSchema).describe("Searches performed to discover likely edit files."),
  candidate_paths: z.array(EditContextCandidateSchema).describe("Deduplicated candidate files selected from known paths and search hits."),
  files: z.array(FileContentSchema).describe("Bundled file contents read from candidate paths."),
  skipped: z.array(z.object({
    path: z.string().describe("Candidate path that could not be read."),
    reason: z.string().describe("Read skip or policy reason.")
  })).describe("Candidate files skipped by read policy, file type, or budget."),
  matched_file_count: z.number().int().nonnegative().describe("Number of candidate files matched before read limits."),
  returned_file_count: z.number().int().nonnegative().describe("Number of candidate files returned with content."),
  truncated: z.boolean().describe("Whether more candidate files remain unread."),
  next_cursor: z.string().optional().describe("Cursor for the suggested repo_read_many follow-up when output was truncated."),
  next_tool_hints: z.object({
    repo_read_many: ReadManyInputSchema.optional().describe("Ready follow-up payload to continue reading candidate files when truncated."),
    repo_write_changes: RepoInputSchema.optional().describe("Minimal payload reminder for the next write step after enough context is gathered."),
    repo_git_review: RepoInputSchema.optional().describe("Minimal payload reminder for the normal post-write review step.")
  }).describe("Suggested low-call-count next tool payloads."),
  warnings: z.array(z.string()).default([]).describe("Combined warnings from search, read, and git head collection.")
});

export type EditContextInput = z.infer<typeof EditContextInputSchema>;
