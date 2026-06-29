import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HandoffInputSchema, type HandoffInput } from "../src/contracts/handoff.contract.js";
import { RepoReaderError } from "../src/runtime/errors.js";
import { HandoffService } from "../src/services/handoff-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("HandoffService", () => {
  test("renders handoff and current pointer", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus());

    const result = await service.write({
      repo_id: "chatgpt-mcp-oss",
      title: "Slice v2.1 Handoff Contract",
      current_track: "safe-write",
      current_state: "Service contract is being implemented.",
      why: "ChatGPT needs a local-only handoff file for future resume flows.",
      completed_work: ["Created service tests", "Mapped write policy"],
      decisions: ["Keep tool catalog wiring out of this slice"],
      workflow: ["Render markdown", "Write current pointer"],
      constraints: ["No git operations", "No absolute paths in output"],
      next_steps: [
        {
          title: "Wire repo_write_handoff",
          goal: "Expose service as a first-class MCP tool",
          done_when: "Tool catalog and handler tests pass"
        }
      ],
      important_files: ["src/services/handoff-service.ts"],
      risks: ["Renderer format may need product copy polish"],
      open_questions: ["Should current pointer include full history?"]
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      handoff_path: ".chatgpt/handoffs/2026-06-02-1200-slice-v2-1-handoff-contract.local.md",
      current_path: ".chatgpt/handoffs/current.local.md",
      updated_current: true,
      branch: "oss/safe-write-core",
      head_sha: "abc123",
      clean: false,
      current_next_step: "Wire repo_write_handoff",
      warnings: []
    });
    expect(result.startup_prompt).toContain(result.handoff_path);
    expect(result.startup_prompt).toContain("Använd GPT-Repo-MCP mot repo_id `chatgpt-mcp-oss`.");
    expect(result.startup_prompt).toContain("Kör `repo_git_status`.");
    expect(result.startup_prompt).toContain("Fortsätt från handoffens \"Next steps\".");

    const handoff = await readFile(join(fixture.root, result.handoff_path), "utf8");
    expect(handoff).toContain("# Slice v2.1 Handoff Contract");
    expect(handoff).toContain("## Git");
    expect(handoff).toContain("- Branch: oss/safe-write-core");
    expect(handoff).toContain("- Clean: false");
    expect(handoff).toContain("### 1. Wire repo_write_handoff");

    expect(result.current_path).toBeDefined();
    const current = await readFile(join(fixture.root, result.current_path!), "utf8");
    expect(current).toContain("# Current Handoff");
    expect(current).toContain(result.handoff_path);
    expect(current).toContain(result.startup_prompt);
  });

  test("dry_run writes no files", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus());

    const result = await service.write(validInput({ dry_run: true }));

    expect(result).toMatchObject({ ok: true, dry_run: true });
    expect(result.handoff_path).toBe(".chatgpt/handoffs/2026-06-02-1200-daily-handoff.local.md");
    expect(result.updated_current).toBe(true);
    await expect(access(join(fixture.root, result.handoff_path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(fixture.root, ".chatgpt", "handoffs", "current.local.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("slug is sanitized", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus());

    const result = await service.write(validInput({ title: "../../API Keys: Fix & Polish!!!" }));

    expect(result.handoff_path).toBe(".chatgpt/handoffs/2026-06-02-1200-api-keys-fix-polish.local.md");
  });

  test("requires at least one next_step", () => {
    expect(() => HandoffInputSchema.parse({
      repo_id: "chatgpt-mcp-oss",
      title: "Daily handoff",
      current_state: "Current state",
      why: "Because resume context is needed.",
      next_steps: []
    })).toThrow();
  });

  test("forces detailed handoff to .local.md", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus(), new WritePolicy({
      enabled: true,
      allowed_globs: [".chatgpt/handoffs/**"],
      denied_globs: ["**/*.local.md"]
    }));

    await expect(service.write(validInput())).rejects.toMatchObject({
      code: "WRITE_DENIED_GLOB"
    } satisfies Partial<RepoReaderError>);
  });

  test("blocks content that secret scanner would block", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus());

    await expect(service.write(validInput({
      current_state: "OPENAI_API_KEY=sk-realSecretValue123"
    }))).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
  });

  test("returns startup_prompt", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus());

    const result = await service.write(validInput());

    expect(result.startup_prompt).toBe([
      "Använd GPT-Repo-MCP mot repo_id `chatgpt-mcp-oss`.",
      "Läs `.chatgpt/handoffs/current.local.md` och sedan `.chatgpt/handoffs/2026-06-02-1200-daily-handoff.local.md`.",
      "Kör `repo_git_status`.",
      "Fortsätt från handoffens \"Next steps\"."
    ].join("\n"));
  });

  test("includes branch head and clean from GitService status", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus({
      branch: "feature/handoff",
      head_sha: "def456",
      clean: true
    }));

    const result = await service.write(validInput());

    expect(result.branch).toBe("feature/handoff");
    expect(result.head_sha).toBe("def456");
    expect(result.clean).toBe(true);
  });

  test("creates parent directory when needed", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus());

    const result = await service.write(validInput());

    await expect(readFile(join(fixture.root, result.handoff_path), "utf8")).resolves.toContain("# Daily Handoff");
  });

  test("update_current=false writes only detailed handoff", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, gitStatus());

    const result = await service.write(validInput({ update_current: false }));

    expect(result.updated_current).toBe(false);
    expect(result.current_path).toBeUndefined();
    await expect(readFile(join(fixture.root, result.handoff_path), "utf8")).resolves.toContain("# Daily Handoff");
    await expect(access(join(fixture.root, ".chatgpt", "handoffs", "current.local.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createService(root: string, status: GitStatus, policy = new WritePolicy({
  enabled: true,
  allowed_globs: [".chatgpt/handoffs/**"]
})) {
  return new HandoffService(root, new PathSandbox(root), policy, {
    status: async () => status
  }, fixedNow);
}

function fixedNow() {
  return new Date(2026, 5, 2, 12, 0, 0, 0);
}

function validInput(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    repo_id: "chatgpt-mcp-oss",
    title: "Daily Handoff",
    current_state: "Implementation is in progress.",
    why: "The next session needs structured local context.",
    next_steps: [
      {
        title: "Continue implementation",
        goal: "Finish handoff service",
        done_when: "All handoff service tests pass"
      }
    ],
    ...overrides
  };
}

function gitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "oss/safe-write-core",
    head_sha: "abc123",
    clean: false,
    counts: { "??": 1 },
    files: [{ index: "?", worktree: "?", path: "tests/handoff-service.test.ts" }],
    ...overrides
  };
}

type GitStatus = {
  branch: string;
  head_sha: string;
  clean: boolean;
  counts: Record<string, number>;
  files: Array<{ path: string; original_path?: string; index: string; worktree: string }>;
};
