import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { NextActionService } from "../src/services/next-action-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";

const execFileAsync = promisify(execFile);

describe("NextActionService", () => {
  test("recommends planning from project brief and task inventory", async () => {
    const root = await createNextActionFixture();
    const result = await new NextActionService({ repo_id: "fixture", display_name: "Fixture", root }, new PathSandbox(root)).recommend({
      mode: "plan",
      horizon: "today"
    });

    expect(result.recommendation).toBe("Start from project brief and backlog signals");
    expect(result.suggested_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool_hint: "repo_project_brief" }),
      expect.objectContaining({ tool_hint: "repo_change_plan" })
    ]));
    expect(result.rationale).toEqual(expect.arrayContaining([
      expect.stringContaining("Mode is plan"),
      expect.stringContaining("Detected")
    ]));
    expect(result.useful_context.map((context) => context.path)).toContain("README.md");
    expect(result.confidence).not.toBe("low");
  });

  test("ship mode prioritizes diff review when working tree is dirty", async () => {
    const root = await createNextActionFixture();
    await writeFile(join(root, "src", "app.ts"), "export const changed = true;\n");

    const result = await new NextActionService({ repo_id: "fixture", display_name: "Fixture", root }, new PathSandbox(root)).recommend({
      mode: "ship"
    });

    expect(result.recommendation).toBe("Review current diff before shipping");
    expect(result.suggested_actions[0]).toMatchObject({
      tool_hint: "repo_git_diff",
      risk: "medium"
    });
    expect(result.useful_context.map((context) => context.path)).toContain("src/app.ts");
  });

  test("refactor mode recommends decision memory and change plan", async () => {
    const root = await createNextActionFixture();
    const result = await new NextActionService({ repo_id: "fixture", display_name: "Fixture", root }, new PathSandbox(root)).recommend({
      mode: "refactor"
    });

    expect(result.suggested_actions.map((action) => action.tool_hint)).toEqual(expect.arrayContaining([
      "repo_decision_memory",
      "repo_change_plan"
    ]));
  });
});

async function createNextActionFixture() {
  const root = await mkdtemp(join(tmpdir(), "next-action-fixture-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await writeFile(join(root, "TODO.md"), "- [ ] Add focused validation\n");
  await writeFile(join(root, "src", "app.ts"), "export const fixture = true;\n");
  await writeFile(join(root, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "vitest",
      typecheck: "tsc --noEmit"
    }
  }, null, 2));
  await execFileAsync("git", ["init"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["add", "."], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  return root;
}
