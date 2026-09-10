import { z } from "zod";
import { FileContentSchema, GlobScopeSchema, ReadManyInputSchema } from "./file.contract.js";
import { RepoInputSchema } from "./repo.contract.js";
import { SearchResultSchema } from "./search.contract.js";

export const EditContextInputSchema = RepoInputSchema
  .merge(GlobScopeSchema)
  .extend({
    goal: z.string().min(1).max(120).describe("Brief search intent for repo_edit_context, ideally 2-8 words. Name the code area and desired change only; omit background, reasoning, implementation details, acceptance criteria, and file lists."),
    search_queries: z.array(z.string().min(1)).max(10).optional().describe("Up to 10 exact identifiers, error fragments, function names, or file words to search before reading files. Omit only when known_paths or include_globs are sufficient. Example: [\"WriteChangesToolInputSchema\", \"grouped edit\"]."),
    known_paths: z.array(z.string().min(1)).max(50).optional().describe("Up to 50 repo-relative POSIX files already known to be relevant; these are read before search-derived candidates. Example: [\"src/contracts/write.contract.ts\"]."),
    max_search_results_per_query: z.number().int().positive().optional().describe("Maximum search hits retained per query before candidate ranking. Defaults to 16 and is capped by the configured search-result limit."),
    max_files_to_read: z.number().int().positive().optional().describe("Maximum candidate files to read in the bundled repo_read_many step. Defaults to 8 and is capped by the server max_files limit."),
    max_bytes_per_file: z.number().int().positive().optional().describe("Maximum bytes returned for each candidate file. Omit to use the configured per-file limit; larger values are capped."),
    max_total_bytes: z.number().int().positive().optional().describe("Total read budget for bundled file contents. Defaults to 300000 bytes and is capped by server configuration."),
    context_lines: z.number().int().min(0).max(5).optional().describe("Search context lines per match. Defaults to 0 because selected file contents are read separately; context is removed when the full file is returned.")
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
  searches: z.array(EditContextSearchSchema).describe("Searches performed to discover likely edit files, compacted to the first read page of candidates."),
  candidate_paths: z.array(EditContextCandidateSchema).describe("Deduplicated candidate files ranked by known-path status, distinct query coverage, hit count, and file type."),
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
