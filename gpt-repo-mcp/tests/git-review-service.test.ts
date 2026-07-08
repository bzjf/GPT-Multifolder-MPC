import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { CleanupService } from "../src/services/cleanup-service.js";
import { GitOperationsService } from "../src/services/git-operations-service.js";
import { GitService } from "../src/services/git-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";

const execFileAsync = promisify(execFile);

describe("GitReviewService", () => {
  test("clean repo returns NO_CHANGES and no payloads", async () => {
    const fixture = await createGitFixture();
    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.clean).toBe(true);
    expect(result.changed_paths).toEqual([]);
    expect(result.recommendation).toMatchObject({
      ready_to_stage: false,
      recommended_stage_paths: [],
      suggested_commit_message: "No changes to commit",
      risk_level: "low",
      warnings: ["NO_CHANGES"]
    });
    expect(result.recommendation).not.toHaveProperty("recovery_guidance");
    expect(result.next_tool_payloads).toEqual({});
  });

  test("clean review uses only the status command and skips both diffs", async () => {
    const calls: string[][] = [];
    const head = "a".repeat(40);
    const git = new GitService("unused", async (args) => {
      calls.push(args);
      if (args.includes("status")) {
        return `# branch.oid ${head}\n# branch.head main\n`;
      }
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    });

    const result = await new GitReviewService("unused", new OperationsPolicy(), git).review({ repo_id: "fixture" });

    expect(result.clean).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("status");
  });

  test("compact review caps summaries and skips an absent staged diff", async () => {
    const calls: string[][] = [];
    const head = "c".repeat(40);
    const statusLines = Array.from({ length: 60 }, (_, index) =>
      `1 .M N... 100644 100644 100644 ${"1".repeat(40)} ${"1".repeat(40)} docs/file-${index}.md`
    );
    const diff = Array.from({ length: 60 }, (_, index) => [
      `diff --git a/docs/file-${index}.md b/docs/file-${index}.md`,
      `--- a/docs/file-${index}.md`,
      `+++ b/docs/file-${index}.md`,
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n")).join("\n");
    const git = new GitService("unused", async (args) => {
      calls.push(args);
      if (args.includes("status")) {
        return [`# branch.oid ${head}`, "# branch.head main", ...statusLines, ""].join("\n");
      }
      if (args[0] === "diff" && !args.includes("--cached")) return diff;
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    });

    const result = await new GitReviewService("unused", new OperationsPolicy(), git).review({ repo_id: "fixture" });

    expect(calls).toHaveLength(2);
    expect(calls.some((args) => args.includes("--cached"))).toBe(false);
    expect(result.diff_summary.file_count).toBe(60);
    expect(result.diff_summary.files).toHaveLength(50);
    expect(result.diff_summary.truncated).toBe(true);
    expect(result.recommendation.warnings).toContain("DIFF_SUMMARY_TRUNCATED");
  });

  test("default review omits duplicated action payloads", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.clean).toBe(false);
    expect(result.recommendation.recommended_stage_paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads).toEqual({});
  });

  test("internal workflows can default reviews to commit_plan", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");

    const result = await new GitReviewService(
      fixture.root,
      new OperationsPolicy(),
      undefined,
      "commit_plan"
    ).review({ repo_id: "fixture" });

    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeDefined();
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toBeDefined();
  });

  test("modified tracked files produce explicit recommended paths and composite payloads", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan" });

    expect(result.clean).toBe(false);
    expect(result.head_sha).toBe(fixture.head);
    expect(result.changed_paths).toEqual([
      expect.objectContaining({
        path: "docs/a.md",
        status: "modified",
        staged: false,
        unstaged: true
      })
    ]);
    expect(result.recommendation.recommended_stage_paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_git_restore_paths_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_git_restore_paths_actual).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_stage_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_actual?.dry_run).toBe(false);
    expect(result.next_tool_payloads.repo_write_commit_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/a.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      message: "Update docs",
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      message: "Update docs",
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      restore_paths: ["docs/a.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      restore_paths: ["docs/a.md"],
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_recover_dry_run).not.toHaveProperty("unstage_paths");
    expectNoGeneratedReasons(result.next_tool_payloads);

    const operations = new GitOperationsService(fixture.root, createFullOperationsPolicy());
    await expect(operations.stage(result.next_tool_payloads.repo_write_stage_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      staged_paths: ["docs/a.md"]
    });
    await expect(operations.stageCommit(result.next_tool_payloads.repo_write_stage_commit_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      staged_paths: ["docs/a.md"],
      committed_paths: ["docs/a.md"]
    });
    await expect(operations.restorePaths(result.next_tool_payloads.repo_git_restore_paths_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      restored_paths: ["docs/a.md"]
    });
    await expect(operations.recover(result.next_tool_payloads.repo_write_recover_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      restored_paths: ["docs/a.md"]
    });
  });

  test("staged files produce commit dry-run payload with expected_staged_paths", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan" });

    expect(result.recommendation.ready_to_stage).toBe(false);
    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.next_tool_payloads.repo_write_stage_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(result.next_tool_payloads.repo_git_restore_paths_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_git_restore_paths_actual).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md"],
      dry_run: false
    });
    expect(result.recommendation.warnings).toContain("STAGED_RECOVERY_REQUIRES_UNSTAGE_FIRST");
    expect(result.recommendation.recovery_guidance).toEqual([
      "Staged paths cannot be restored directly with repo_git_restore_paths because restore is worktree-only.",
      "For bad staged changes, use repo_write_recover with the review-provided unstage_paths and restore_paths, or use repo_write_unstage first when granular control is needed.",
      "If the staged diff is good, use repo_write_commit_dry_run before committing the exact staged paths."
    ]);
    expect(result.next_tool_payloads.repo_write_unstage_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_unstage_actual).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_commit_dry_run).toEqual({
      repo_id: "fixture",
      message: "Update docs",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/a.md"],
      dry_run: true
    });
    expectNoGeneratedReasons(result.next_tool_payloads);
  });

  test("staged Codex run artifacts are excluded from commit and stage payloads", async () => {
    const fixture = await createGitFixture();
    const resultPath = ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md";
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs", "2026-06-04T081500Z-fix-login-expiry"), { recursive: true });
    await writeFile(join(fixture.root, resultPath), "# CODEX_RESULT\nstatus: completed\nsummary: local only\n");
    await git(fixture.root, ["add", "--", resultPath]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan" });

    expect(result.recommendation.excluded_paths).toContainEqual({
      path: resultPath,
      reason: "LOCAL_CODEX_ARTIFACT_EXCLUDED"
    });
    expect(result.recommendation.recommended_stage_paths).not.toContain(resultPath);
    expect(result.next_tool_payloads.repo_write_stage_dry_run?.paths ?? []).not.toContain(resultPath);
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run?.paths ?? []).not.toContain(resultPath);
    expect(result.next_tool_payloads.repo_write_commit_dry_run?.expected_staged_paths ?? []).not.toContain(resultPath);
  });

  test("staged Codex run artifacts block one-shot stage commit payloads for other files", async () => {
    const fixture = await createGitFixture();
    const resultPath = ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md";
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs", "2026-06-04T081500Z-fix-login-expiry"), { recursive: true });
    await writeFile(join(fixture.root, resultPath), "# CODEX_RESULT\nstatus: completed\nsummary: local only\n");
    await git(fixture.root, ["add", "--", resultPath]);
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan" });

    expect(result.recommendation.recommended_stage_paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_stage_dry_run?.paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_commit_dry_run?.expected_staged_paths ?? []).not.toContain(resultPath);
  });

  test("mixed staged and unstaged tracked files produce commit payload for post-stage union", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A staged\n");
    await writeFile(join(fixture.root, "docs", "b.md"), "B unstaged\n");
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan" });

    expect(result.next_tool_payloads.repo_write_stage_dry_run?.paths).toEqual(["docs/b.md"]);
    expect(result.next_tool_payloads.repo_git_restore_paths_dry_run?.paths).toEqual(["docs/b.md"]);
    expect(result.next_tool_payloads.repo_write_unstage_dry_run?.paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md", "docs/b.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md", "docs/b.md"],
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(result.recommendation.warnings).toContain("STAGED_RECOVERY_REQUIRES_UNSTAGE_FIRST");
    expect(result.recommendation.recovery_guidance?.join(" ")).toContain("repo_write_recover");
    expect(result.next_tool_payloads.repo_write_commit_dry_run?.expected_staged_paths).toEqual([
      "docs/a.md",
      "docs/b.md"
    ]);
    expect(result.recommendation.suggested_commit_message).toBe("Update docs");
    expectNoGeneratedReasons(result.next_tool_payloads);
  });

  test("staged-only changes are represented in diff summary", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A staged\n");
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.diff_summary).toMatchObject({
      file_count: 1,
      truncated: false
    });
    expect(result.diff_summary.files).toEqual([
      expect.objectContaining({
        path: "docs/a.md",
        hunk_count: 1
      })
    ]);
  });

  test("untracked files are listed and warned/excluded conservatively", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "new.md"), "New\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.changed_paths).toEqual([
      expect.objectContaining({
        path: "docs/new.md",
        status: "untracked",
        staged: false,
        unstaged: true
      })
    ]);
    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.recommendation.excluded_paths).toEqual([
      { path: "docs/new.md", reason: "UNTRACKED_REQUIRES_EXPLICIT_REVIEW" }
    ]);
    expect(result.recommendation.warnings).toContain("UNTRACKED_PATHS_EXCLUDED");
    expect(result.recommendation).not.toHaveProperty("recovery_guidance");
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(result.next_tool_payloads).toEqual({});
  });

  test("cleanup-eligible untracked generated files produce cleanup payloads", async () => {
    const fixture = await createGitFixture();
    await mkdir(join(fixture.root, "coverage"), { recursive: true });
    await writeFile(join(fixture.root, "coverage", "report.txt"), "coverage\n");

    const result = await new GitReviewService(fixture.root, createCleanupPolicy()).review({ repo_id: "fixture", mode: "commit_plan" });

    expect(result.changed_paths).toEqual([
      expect.objectContaining({
        path: "coverage/report.txt",
        status: "untracked",
        staged: false,
        unstaged: true
      })
    ]);
    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.next_tool_payloads.repo_cleanup_paths_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["coverage/report.txt"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_cleanup_paths_actual).toEqual({
      repo_id: "fixture",
      paths: ["coverage/report.txt"],
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      cleanup_paths: ["coverage/report.txt"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      cleanup_paths: ["coverage/report.txt"],
      dry_run: false
    });
    expect(result.recommendation).not.toHaveProperty("recovery_guidance");
    expectNoGeneratedReasons(result.next_tool_payloads);

    const cleanup = new CleanupService(fixture.root, createCleanupPolicy());
    await expect(cleanup.cleanup(result.next_tool_payloads.repo_cleanup_paths_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      deleted: [{ path: "coverage/report.txt", type: "file" }]
    });
    const operations = new GitOperationsService(fixture.root, createCleanupPolicy());
    await expect(operations.recover(result.next_tool_payloads.repo_write_recover_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      deleted: [{ path: "coverage/report.txt", type: "file" }]
    });
  });

  test("untracked Codex run artifacts produce cleanup payloads and are excluded from staging", async () => {
    const fixture = await createGitFixture();
    const resultPath = ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md";
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs", "2026-06-04T081500Z-fix-login-expiry"), { recursive: true });
    await writeFile(join(fixture.root, resultPath), "# CODEX_RESULT\nstatus: completed\nsummary: local only\n");

    const result = await new GitReviewService(fixture.root, createCleanupPolicy()).review({ repo_id: "fixture", mode: "commit_plan" });

    expect(result.recommendation.excluded_paths).toContainEqual({
      path: resultPath,
      reason: "LOCAL_CODEX_ARTIFACT_EXCLUDED"
    });
    expect(result.recommendation.recommended_stage_paths).not.toContain(resultPath);
    expect(result.next_tool_payloads.repo_cleanup_paths_dry_run).toEqual({
      repo_id: "fixture",
      paths: [resultPath],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      cleanup_paths: [resultPath],
      dry_run: true
    });
  });

  test("untracked non-cleanup-eligible files do not produce cleanup payloads", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "new.md"), "New\n");

    const result = await new GitReviewService(fixture.root, createCleanupPolicy()).review({ repo_id: "fixture" });

    expect(result.next_tool_payloads.repo_cleanup_paths_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_cleanup_paths_actual).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_recover_actual).toBeUndefined();
    expect(result.recommendation.warnings).toContain("UNTRACKED_PATHS_EXCLUDED");
  });

  test("deleted tracked worktree path produces recover restore payload but no stage commit payload", async () => {
    const fixture = await createGitFixture();
    await git(fixture.root, ["rm", "--", "docs/a.md"]);
    await git(fixture.root, ["restore", "--staged", "--", "docs/a.md"]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan" });

    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.recommendation.excluded_paths).toEqual([
      { path: "docs/a.md", reason: "DELETED_PATH_REQUIRES_EXPLICIT_REVIEW" }
    ]);
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      restore_paths: ["docs/a.md"],
      dry_run: true
    });
  });

  test("truncated diff summary propagates warning and elevated risk", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");
    await writeFile(join(fixture.root, "docs", "b.md"), "B changed\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", max_files: 1 });

    expect(result.diff_summary).toMatchObject({
      file_count: 2,
      truncated: true
    });
    expect(result.diff_summary.files).toHaveLength(1);
    expect(result.recommendation.risk_level).toBe("medium");
    expect(result.recommendation.warnings).toContain("DIFF_SUMMARY_TRUNCATED");
  });
});

function expectNoGeneratedReasons(payloads: Record<string, unknown>): void {
  for (const [name, payload] of Object.entries(payloads)) {
    expect(payload, name).not.toHaveProperty("reason");
  }
}

function createCleanupPolicy(): OperationsPolicy {
  return new OperationsPolicy({
    enabled: true,
    cleanup_enabled: true
  });
}

function createFullOperationsPolicy(): OperationsPolicy {
  return new OperationsPolicy({
    enabled: true,
    git_stage_enabled: true,
    git_commit_enabled: true,
    cleanup_enabled: true
  });
}

async function createGitFixture(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "gpt-repo-mcp-review-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "a.md"), "A\n");
  await writeFile(join(root, "docs", "b.md"), "B\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["add", "--", "docs/a.md", "docs/b.md"]);
  await git(root, ["commit", "-m", "initial"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { root, head };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" }
  });
  return result.stdout;
}
