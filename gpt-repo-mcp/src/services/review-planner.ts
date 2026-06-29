export function recommendToolForPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/(vilka repo|list.*repo|repo:n|repos)/i.test(prompt)) return "repo_list_roots";
  if (/(onboard|översikt|overview|sammanfatta|förstå|daily planning|daglig planering|planera arbetet)/i.test(prompt)) return "repo_project_brief";
  if (/(todo|fixme|hack|roadmap|checklist|backlog|nästa task|uppgifter)/i.test(prompt)) return "repo_task_inventory";
  if (/(vad ska jag göra härnäst|what next|prioritera|prioritize|ready to ship|redo att shippa|ship|cleanup|städa)/i.test(prompt)) return "repo_next_action";
  if (/(hur implementerar jag|implementera|add feature|fixa|bug|debug|refactor|refaktor|planera ändring)/i.test(prompt)) return "repo_change_plan";
  if (/(varför|decisions|conventions|architecture decisions|projektminne|project memory|mönster|patterns)/i.test(prompt)) return "repo_decision_memory";
  if (/(struktur|tree|träd|visa strukturen)/i.test(prompt)) return "repo_tree";
  if (/(granska mina ändringar|diff|ändringar|changes)/i.test(prompt)) return "repo_git_diff";
  if (/(komplett|fullständig|hela repo|förbättringsförslag|review my repo|granska mitt repo)/i.test(prompt)) return "repo_plan_review";
  if (/(läs alla|alla controllers|read many|controllers)/i.test(lower)) return "repo_read_many";
  if (/(läs|read|visa).+\.[a-z0-9]+/i.test(prompt)) return "repo_fetch_file";
  if (/(hitta|sök|find|search|usages|raw fetch)/i.test(prompt)) return "repo_search";
  return "repo_plan_review";
}

export class ReviewPlanner {
  plan(prompt: string) {
    const explicitFullRepo = /(komplett|fullständig|hela repo|whole repo|full analysis)/i.test(prompt);
    const broadReview = /(granska|review|förbättringsförslag)/i.test(prompt);
    return {
      should_ask_clarifying_question: broadReview && !explicitFullRepo,
      suggested_question: broadReview && !explicitFullRepo
        ? "Vilken del av repot eller vilka ändringar vill du att jag granskar först?"
        : undefined,
      recommended_next_tools: explicitFullRepo
        ? ["repo_project_brief", "repo_task_inventory", "repo_decision_memory", "repo_tree", "repo_search", "repo_read_many"]
        : [recommendToolForPrompt(prompt)],
      recommended_scope: explicitFullRepo
        ? "Staged broad review: project brief, task inventory, decision memory, tree/search drilldown, then targeted read_many batches. Use repo_next_action separately for planning or next-work prioritization."
        : "Target the smallest relevant set of files before reading contents.",
      estimated_cost: explicitFullRepo ? "high" : broadReview ? "medium" : "low",
      explicit_full_repo: explicitFullRepo
    } as const;
  }
}
