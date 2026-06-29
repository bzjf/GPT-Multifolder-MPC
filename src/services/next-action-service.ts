import type { RepoConfig } from "./root-registry.js";
import type { PathSandbox } from "./path-sandbox.js";
import { GitService } from "./git-service.js";
import { ProjectBriefService } from "./project-brief-service.js";
import { TaskInventoryService } from "./task-inventory-service.js";
import type { NextActionInput, NextActionMode } from "../contracts/next-action.contract.js";

type NextActionOptions = Omit<NextActionInput, "repo_id">;
type SuggestedAction = {
  title: string;
  reason: string;
  tool_hint?: "repo_project_brief" | "repo_task_inventory" | "repo_git_status" | "repo_git_diff" | "repo_search" | "repo_fetch_file" | "repo_read_many" | "repo_change_plan" | "repo_decision_memory";
  risk: "low" | "medium" | "high";
};

export class NextActionService {
  constructor(private readonly repo: RepoConfig, private readonly sandbox: PathSandbox) {}

  async recommend(options: NextActionOptions = {}) {
    const mode = options.mode ?? "plan";
    const warnings: string[] = [];
    const [projectBrief, taskInventory, gitStatus] = await Promise.all([
      new ProjectBriefService(this.repo, this.sandbox).brief({ include: ["package", "readme", "scripts", "todos"] }),
      new TaskInventoryService(this.repo.root, this.sandbox).inventory({ max_results: 10 }),
      readGitStatus(this.repo.root, warnings)
    ]);
    warnings.push(...projectBrief.warnings, ...taskInventory.warnings);

    const blockers = blockersFor(gitStatus, taskInventory);
    const suggestedActions = actionsFor(mode, {
      dirtyFiles: gitStatus?.files.length ?? 0,
      taskCount: taskInventory.matched_count,
      testCommands: projectBrief.test_commands,
      scanComplete: taskInventory.scan_complete
    });
    const recommendation = recommendationFor(mode, suggestedActions, blockers);

    return {
      recommendation,
      rationale: rationaleFor(projectBrief, taskInventory, gitStatus, options),
      suggested_actions: suggestedActions,
      blockers,
      useful_context: usefulContext(projectBrief, taskInventory, gitStatus),
      confidence: confidenceFor(projectBrief, taskInventory, gitStatus, warnings),
      warnings
    };
  }
}

async function readGitStatus(root: string, warnings: string[]) {
  try {
    return await new GitService(root).status();
  } catch {
    warnings.push("GIT_STATUS_UNAVAILABLE");
    return undefined;
  }
}

function actionsFor(mode: NextActionMode, facts: { dirtyFiles: number; taskCount: number; testCommands: string[]; scanComplete: boolean }): SuggestedAction[] {
  const actions: SuggestedAction[] = [];

  if (mode === "ship") {
    if (facts.dirtyFiles > 0) {
      actions.push({
        title: "Review current diff before shipping",
        reason: `${facts.dirtyFiles} changed files are present.`,
        tool_hint: "repo_git_diff",
        risk: "medium"
      });
    }
    actions.push({
      title: "Run the narrowest relevant validation",
      reason: facts.testCommands.length > 0 ? `Available commands include ${facts.testCommands.slice(0, 3).join(", ")}.` : "No test commands were detected in project metadata.",
      risk: facts.testCommands.length > 0 ? "low" : "medium"
    });
    return actions;
  }

  if (mode === "cleanup") {
    actions.push({
      title: "Triage repo-local backlog markers",
      reason: `${facts.taskCount} task inventory items were found${facts.scanComplete ? "" : " in a partial scan"}.`,
      tool_hint: "repo_task_inventory",
      risk: facts.taskCount > 20 ? "medium" : "low"
    });
  }

  if (mode === "debug") {
    actions.push({
      title: "Create a focused change plan for the failing behavior",
      reason: "Debug work should start from a narrow, reproducible target and likely affected files.",
      tool_hint: "repo_change_plan",
      risk: "medium"
    });
  }

  if (mode === "refactor") {
    actions.push({
      title: "Check project decisions and conventions before refactoring",
      reason: "Refactors should preserve existing architecture decisions and local conventions.",
      tool_hint: "repo_decision_memory",
      risk: "medium"
    });
    actions.push({
      title: "Plan the refactor in bounded steps",
      reason: "A change plan can identify files likely touched and validation strategy without editing.",
      tool_hint: "repo_change_plan",
      risk: "medium"
    });
  }

  actions.push({
    title: "Start from project brief and backlog signals",
    reason: "Project overview and repo-local tasks provide the safest basis for choosing focused work.",
    tool_hint: "repo_project_brief",
    risk: "low"
  });
  if (facts.taskCount > 0) {
    actions.push({
      title: "Pick one grounded task and make a change plan",
      reason: "Repo-local TODOs or roadmap notes provide concrete work candidates.",
      tool_hint: "repo_change_plan",
      risk: "low"
    });
  }
  return actions;
}

function recommendationFor(mode: NextActionMode, actions: SuggestedAction[], blockers: string[]): string {
  if (blockers.length > 0 && mode === "ship") {
    return "Do not ship yet; review blockers and current changes first.";
  }
  return actions[0]?.title ?? "Gather project context before choosing work.";
}

function blockersFor(gitStatus: Awaited<ReturnType<GitService["status"]>> | undefined, taskInventory: Awaited<ReturnType<TaskInventoryService["inventory"]>>): string[] {
  const blockers = [];
  if (!gitStatus) {
    blockers.push("Git status is unavailable, so current-change state is unknown.");
  }
  if (taskInventory.truncated || !taskInventory.scan_complete) {
    blockers.push("Task inventory is incomplete; narrow scope or continue pagination before treating backlog counts as complete.");
  }
  return blockers;
}

function rationaleFor(
  projectBrief: Awaited<ReturnType<ProjectBriefService["brief"]>>,
  taskInventory: Awaited<ReturnType<TaskInventoryService["inventory"]>>,
  gitStatus: Awaited<ReturnType<GitService["status"]>> | undefined,
  options: NextActionOptions
): string[] {
  const rationale = [
    `Mode is ${options.mode ?? "plan"} and horizon is ${options.horizon ?? "today"}.`,
    `Project type: ${projectBrief.project_type ?? "unknown"}.`,
    `Detected ${taskInventory.matched_count} repo-local task markers.`
  ];
  rationale.push(gitStatus?.clean ? "Git working tree is clean." : `Git working tree has ${gitStatus?.files.length ?? "unknown"} changed files.`);
  if (projectBrief.test_commands.length > 0) {
    rationale.push(`Detected validation commands: ${projectBrief.test_commands.slice(0, 3).join(", ")}.`);
  }
  return rationale;
}

function usefulContext(
  projectBrief: Awaited<ReturnType<ProjectBriefService["brief"]>>,
  taskInventory: Awaited<ReturnType<TaskInventoryService["inventory"]>>,
  gitStatus: Awaited<ReturnType<GitService["status"]>> | undefined
) {
  const contexts = [
    ...projectBrief.key_docs.map((doc) => ({ path: doc.path, reason: "Project documentation used by project brief." })),
    ...projectBrief.likely_entrypoints.map((path) => ({ path, reason: "Likely implementation entrypoint." })),
    ...taskInventory.tasks.slice(0, 5).map((task) => ({ path: task.path, reason: `${task.kind} task marker at line ${task.line}.` })),
    ...(gitStatus?.files.slice(0, 5).map((file) => ({ path: file.path, reason: "Changed file in git status." })) ?? [])
  ];
  const seen = new Set<string>();
  return contexts.filter((context) => {
    if (seen.has(context.path)) {
      return false;
    }
    seen.add(context.path);
    return true;
  }).slice(0, 12);
}

function confidenceFor(
  projectBrief: Awaited<ReturnType<ProjectBriefService["brief"]>>,
  taskInventory: Awaited<ReturnType<TaskInventoryService["inventory"]>>,
  gitStatus: Awaited<ReturnType<GitService["status"]>> | undefined,
  warnings: string[]
): "low" | "medium" | "high" {
  if (!gitStatus || warnings.length > 0 || !taskInventory.scan_complete) {
    return "low";
  }
  if (projectBrief.key_docs.length === 0 || taskInventory.matched_count === 0) {
    return "medium";
  }
  return "high";
}
