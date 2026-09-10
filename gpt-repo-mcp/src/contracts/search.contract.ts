import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const SearchInputSchema = RepoInputSchema.extend({
  query: z.string().min(1).describe("Non-empty code, identifier, error text, or other file-content pattern to find. Example: \"WriteChangesToolInputSchema\"."),
  mode: z.enum(["literal", "regex"]).default("literal").describe("How to interpret query: literal matches exact text and is the default; regex enables regular-expression syntax. Example regex: \"TODO|FIXME\"."),
  include_globs: z.array(z.string()).optional().describe("Optional repo-relative POSIX globs limiting files searched. Example: [\"src/**/*.ts\", \"tests/**/*.ts\"]."),
  exclude_globs: z.array(z.string()).optional().describe("Optional repo-relative POSIX globs removed from the search scope. Example: [\"**/*.generated.ts\"]."),
  context_lines: z.number().int().min(0).max(5).optional().describe("Lines of surrounding context returned before and after each match, from 0 to 5. Defaults to 0."),
  max_results: z.number().int().positive().optional().describe("Maximum matches to return on this page. Omit to use the configured server limit; larger values are capped."),
  cursor: z.string().optional().describe("Opaque next_cursor from the previous repo_search page with the same query and filters. Omit on the first page; never invent or modify it.")
});

export const SearchResultSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().describe("Exact 1-based source line; copy this value unchanged into a line-number write action."),
  column: z.number().int().positive(),
  text: z.string(),
  before: z.array(z.string()).default([]),
  after: z.array(z.string()).default([])
});

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  matched_count: z.number().int().nonnegative(),
  returned_count: z.number().int().nonnegative(),
  scan_complete: z.boolean(),
  truncated: z.boolean(),
  next_cursor: z.string().optional(),
  warnings: z.array(z.string()).default([])
});
