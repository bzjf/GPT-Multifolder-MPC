import { describe, expect, test } from "vitest";
import { recommendToolForPrompt } from "../src/services/review-planner.js";

describe("golden prompt routing", () => {
  test.each([
    ["Vilka repo:n kan du läsa?", "repo_list_roots"],
    ["Ge mig en snabb översikt av projektet", "repo_project_brief"],
    ["Hitta TODOs och roadmap-notes", "repo_task_inventory"],
    ["Visa strukturen i repo:t", "repo_tree"],
    ["Hitta alla raw fetch mot /api/users", "repo_search"],
    ["Läs docs/EXECUTION-PLAN.md", "repo_fetch_file"],
    ["Läs alla controllers i backend", "repo_read_many"],
    ["Granska mina ändringar", "repo_git_diff"],
    ["Granska mitt repo och ge förbättringsförslag", "repo_plan_review"],
    ["Gör en komplett fullständig analys av hela repo:t", "repo_plan_review"],
    ["Vad ska jag göra härnäst?", "repo_next_action"],
    ["Är detta redo att shippas?", "repo_next_action"],
    ["Hur implementerar jag en ny feature?", "repo_change_plan"],
    ["Planera en refactor av handlers", "repo_change_plan"],
    ["Varför är projektet strukturerat så här?", "repo_decision_memory"],
    ["Vilka conventions styr repot?", "repo_decision_memory"]
  ])("%s => %s", (prompt, toolName) => {
    expect(recommendToolForPrompt(prompt)).toBe(toolName);
  });
});
