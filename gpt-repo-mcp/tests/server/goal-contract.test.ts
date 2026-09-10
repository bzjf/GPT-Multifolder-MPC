import { describe, expect, test } from "vitest";
import { ChangePlanInputSchema } from "../../src/contracts/change-plan.contract.js";
import { EditContextInputSchema } from "../../src/contracts/edit-context.contract.js";
import { HandoffNextStepSchema } from "../../src/contracts/handoff.contract.js";

describe("repo_edit_context goal contract", () => {
  test("caps the search intent at 120 characters", () => {
    const boundaryGoal = "x".repeat(120);
    const oversizedGoal = "x".repeat(121);

    expect(EditContextInputSchema.safeParse({
      repo_id: "fixture",
      goal: boundaryGoal
    }).success).toBe(true);
    expect(EditContextInputSchema.safeParse({
      repo_id: "fixture",
      goal: oversizedGoal
    }).success).toBe(false);
    expect(EditContextInputSchema.shape.goal.description).toContain("ideally 2-8 words");
    expect(EditContextInputSchema.shape.goal.description).toContain("omit background");
  });

  test("encourages concise semantic goals without hard truncation", () => {
    expect(ChangePlanInputSchema.shape.goal.description).toContain("Concise one-sentence planning target");
    expect(ChangePlanInputSchema.shape.goal.description).toContain("directly affects file ranking");
    expect(HandoffNextStepSchema.shape.goal.description).toContain("one-sentence intended outcome");
    expect(HandoffNextStepSchema.shape.goal.description).toContain("put completion details in done_when");
  });
});
