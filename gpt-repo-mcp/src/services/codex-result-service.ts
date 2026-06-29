import { CodexReviewInputSchema, type CodexParsedResult, type CodexReviewInput, type CodexReviewResult } from "../contracts/codex-task.contract.js";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { readFilePrefix } from "./bounded-read.js";
import type { GitReviewService } from "./git-review-service.js";
import { PathSandbox } from "./path-sandbox.js";
import { SecretScanner } from "./secret-scanner.js";
import { codexRunPaths } from "./codex-task-service.js";

export class CodexResultService {
  private readonly secretScanner = new SecretScanner();

  constructor(
    private readonly sandbox: PathSandbox,
    private readonly gitReviewService: GitReviewService
  ) {}

  async review(rawInput: CodexReviewInput): Promise<CodexReviewResult> {
    const input = CodexReviewInputSchema.parse(rawInput);
    const paths = codexRunPaths(input.run_id);
    let resultText: string | undefined;
    try {
      const resolved = await this.sandbox.resolve(paths.resultPath);
      if (!resolved.stat.isFile()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Not a regular file: ${resolved.repoPath}`);
      }
      const { buffer, truncated } = await readFilePrefix(resolved.absolutePath, DEFAULT_LIMITS.max_bytes_per_file);
      if (truncated) {
        throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `File exceeds max_bytes: ${resolved.repoPath}`);
      }
      resultText = this.secretScanner.redact(decodeSafeText(buffer, resolved.repoPath));
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      return {
        ok: true,
        repo_id: input.repo_id,
        run_id: input.run_id,
        result_path: paths.resultPath,
        result_found: false,
        next_steps: [
          "Paste Codex output into ChatGPT, or rerun Codex with the prompt completion contract.",
          "After RESULT.md exists, call repo_codex_review again."
        ],
        warnings: ["CODEX_RESULT_MISSING"]
      };
    }

    const codexResult = parseCodexResult(resultText);
    const gitReview = await this.gitReviewService.review({
      repo_id: input.repo_id,
      ...(input.max_files ? { max_files: input.max_files } : {})
    });
    return {
      ok: true,
      repo_id: input.repo_id,
      run_id: input.run_id,
      result_path: paths.resultPath,
      result_found: true,
      codex_result: codexResult,
      git_review: gitReview,
      next_tool_payloads: gitReview.next_tool_payloads,
      next_steps: [
        "Review codex_result together with git_review.",
        "If the diff is good, use the review-provided stage/commit payload after user approval.",
        "If the diff is bad, use the review-provided recovery payload after user approval."
      ],
      warnings: gitReview.recommendation.warnings
    };
  }
}

function decodeSafeText(buffer: Buffer, repoPath: string): string {
  if (buffer.includes(0)) {
    throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file blocked: ${repoPath}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new RepoReaderError("BINARY_FILE_REJECTED", `Invalid UTF-8 file blocked: ${repoPath}`);
  }
}

function parseCodexResult(text: string): CodexParsedResult {
  return {
    status: parseStatus(fieldText(text, "status")),
    summary: fieldText(text, "summary"),
    changed_files: fieldList(text, "changed_files"),
    commands_run: fieldList(text, "commands_run"),
    tests: fieldList(text, "tests"),
    acceptance_criteria: fieldList(text, "acceptance_criteria"),
    blockers: fieldList(text, "blockers"),
    followups: fieldList(text, "followups"),
    raw_text: text
  };
}

function parseStatus(value: string): CodexParsedResult["status"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed" || normalized === "blocked") {
    return normalized;
  }
  return "unknown";
}

function fieldText(text: string, field: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.toLowerCase().startsWith(`${field}:`));
  const inline = line ? line.slice(field.length + 1).trim() : "";
  if (inline) {
    return inline;
  }
  return fieldBlock(text, field).join("\n");
}

function fieldList(text: string, field: string): string[] {
  const inline = fieldText(text, field);
  const block = fieldBlock(text, field);
  if (block.length === 0) {
    return inline ? [inline] : [];
  }
  return block.map((value) => value.startsWith("- ") ? value.slice(2).trim() : value);
}

function fieldBlock(text: string, field: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((entry) => entry.toLowerCase().trim() === `${field}:`);
  if (start < 0) {
    return [];
  }
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z_]+:/i.test(line.trim())) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      values.push(trimmed);
    }
  }
  return values;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}
