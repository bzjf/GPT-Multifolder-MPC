import { DEFAULT_LIMITS } from "../policies/limits.js";
import { isExcludedByGlob, matchesGlob } from "./glob-service.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";
import { RepoTreeService } from "./repo-tree-service.js";
import type { ChangePlanInput, PlanningDepth } from "../contracts/change-plan.contract.js";

type ChangePlanOptions = Omit<ChangePlanInput, "repo_id">;
type RelevantFile = {
  path: string;
  reason: string;
};

const IMPLEMENTATION_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|java|css|html|json|md)$/;

export class ChangePlanService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async plan(options: ChangePlanOptions) {
    const warnings: string[] = [];
    const maxFiles = Math.min(options.max_files_to_inspect ?? maxFilesForDepth(options.planning_depth), DEFAULT_LIMITS.max_change_plan_files);
    const candidates = await this.collectCandidateFiles(options, warnings);
    const rankedFiles = rankRelevantFiles(options.goal, candidates);
    if (rankedFiles.length > maxFiles) {
      warnings.push("RELEVANT_FILE_LIMIT_REACHED");
    }
    const relevantFiles = rankedFiles
      .slice(0, maxFiles)
      .map((path) => ({ path, reason: reasonFor(path, options.goal) }));
    const scanComplete = !warnings.includes("TREE_SCAN_INCOMPLETE") && !warnings.includes("TREE_CURSOR_MISSING");

    return {
      goal: options.goal,
      relevant_files: relevantFiles,
      proposed_steps: proposedSteps(options.goal, relevantFiles, options.planning_depth),
      test_strategy: testStrategy(candidates, relevantFiles),
      open_questions: openQuestions(options.goal, relevantFiles),
      estimated_cost: estimatedCost(options.planning_depth, relevantFiles.length, scanComplete),
      scan_complete: scanComplete,
      warnings
    };
  }

  private async collectCandidateFiles(options: ChangePlanOptions, warnings: string[]): Promise<string[]> {
    const treeService = new RepoTreeService(this.root, this.sandbox);
    const candidates: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    while (pages < DEFAULT_LIMITS.max_change_plan_tree_pages) {
      const tree = await treeService.tree({
        include_files: true,
        respect_default_excludes: true,
        page_size: DEFAULT_LIMITS.max_tree_entries,
        cursor
      });
      pages += 1;

      for (const entry of tree.entries) {
        if (entry.type !== "file") {
          continue;
        }
        if (!IMPLEMENTATION_EXTENSIONS.test(entry.path)) {
          continue;
        }
        if (this.ignoreEngine.isSensitiveCandidate(entry.path)) {
          continue;
        }
        if (!isIncluded(entry.path, options.include_globs)) {
          continue;
        }
        candidates.push(entry.path);
      }

      if (!tree.truncated) {
        return candidates;
      }
      cursor = tree.next_cursor;
      if (!cursor) {
        warnings.push("TREE_CURSOR_MISSING");
        return candidates;
      }
    }

    warnings.push("TREE_SCAN_INCOMPLETE");
    return candidates;
  }
}

function maxFilesForDepth(depth: PlanningDepth = "standard"): number {
  if (depth === "quick") {
    return 8;
  }
  if (depth === "deep") {
    return 30;
  }
  return 15;
}

function rankRelevantFiles(goal: string, candidates: string[]): string[] {
  const terms = goalTerms(goal);
  return [...candidates].sort((a, b) => scoreFile(b, terms) - scoreFile(a, terms) || a.localeCompare(b));
}

function scoreFile(path: string, terms: string[]): number {
  const lower = path.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += 5;
    }
  }
  if (/(^|\/)(src|app|server|lib)\//.test(lower)) {
    score += 3;
  }
  if (/test|spec|vitest|jest/.test(lower)) {
    score += 2;
  }
  if (/readme|architecture|agents|package\.json/.test(lower)) {
    score += 1;
  }
  return score;
}

function goalTerms(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9åäö]+/i)
    .filter((term) => term.length >= 3)
    .slice(0, 12);
}

function reasonFor(path: string, goal: string): string {
  const terms = goalTerms(goal).filter((term) => path.toLowerCase().includes(term));
  if (terms.length > 0) {
    return `Path matches goal terms: ${terms.join(", ")}.`;
  }
  if (/test|spec/.test(path)) {
    return "Likely validation coverage for the requested change.";
  }
  if (path === "package.json") {
    return "Project scripts and dependencies can shape implementation and validation.";
  }
  if (path.startsWith("docs/") || /readme/i.test(path)) {
    return "Project documentation may contain constraints or expected behavior.";
  }
  return "High-signal implementation path from repository structure.";
}

function proposedSteps(goal: string, relevantFiles: RelevantFile[], depth: PlanningDepth = "standard") {
  const files = relevantFiles.map((file) => file.path);
  const steps = [
    {
      order: 1,
      title: "Confirm scope and constraints",
      description: `Clarify the intended behavior for: ${goal}`,
      files_likely_touched: files.filter((path) => /readme|docs|agents|package\.json/i.test(path)),
      risk: "low" as const
    },
    {
      order: 2,
      title: "Inspect relevant implementation paths",
      description: "Read the highest-signal files before editing and confirm existing patterns.",
      files_likely_touched: files.filter((path) => !/test|spec/i.test(path)).slice(0, 8),
      risk: depth === "deep" ? "medium" as const : "low" as const
    },
    {
      order: 3,
      title: "Implement the smallest coherent change",
      description: "Modify the focused implementation files while preserving established contracts and boundaries.",
      files_likely_touched: files.filter((path) => !/test|spec|readme|docs/i.test(path)).slice(0, 8),
      risk: relevantFiles.length > 12 ? "medium" as const : "low" as const
    },
    {
      order: 4,
      title: "Add or update focused validation",
      description: "Cover the changed behavior with targeted tests or contract checks.",
      files_likely_touched: files.filter((path) => /test|spec/i.test(path)).slice(0, 8),
      risk: "medium" as const
    }
  ];
  return depth === "quick" ? steps.slice(0, 3) : steps;
}

function testStrategy(candidates: string[], relevantFiles: RelevantFile[]): string[] {
  const strategy = [];
  if (candidates.includes("package.json")) {
    strategy.push("Inspect package scripts and run the narrowest relevant validation command.");
  }
  if (relevantFiles.some((file) => /test|spec/.test(file.path))) {
    strategy.push("Run targeted tests covering files likely touched by the change.");
  }
  strategy.push("Run MCP/tool contract tests if the change affects tool schemas, descriptions, handlers, or structured outputs.");
  strategy.push("Run typecheck and lint before committing.");
  return strategy;
}

function openQuestions(goal: string, relevantFiles: RelevantFile[]): string[] {
  const questions = [];
  if (relevantFiles.length === 0) {
    questions.push("Which files or subsystem should this goal target?");
  }
  if (!/(test|validation|schema|contract|ui|api|mcp|docs?)/i.test(goal)) {
    questions.push("What observable behavior should prove this change is complete?");
  }
  return questions;
}

function estimatedCost(depth: PlanningDepth = "standard", fileCount: number, scanComplete: boolean): "small" | "medium" | "large" {
  if (!scanComplete || depth === "deep" || fileCount > 15) {
    return "large";
  }
  if (depth === "standard" || fileCount > 6) {
    return "medium";
  }
  return "small";
}

function isIncluded(path: string, includeGlobs: string[] = []): boolean {
  if (includeGlobs.length === 0) {
    return true;
  }
  return includeGlobs.some((glob) => matchesGlob(path, glob)) && !isExcludedByGlob(path);
}
