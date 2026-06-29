# Architecture

GPT Repo MCP (`gpt-repo-mcp`) is a tool-only MCP server. There is no widget in v1. The server exposes a Streamable HTTP `/mcp` endpoint plus a local health route.

## Boundaries

- `src/server.ts` owns the HTTP server, `/mcp` transport, and `/health`.
- `src/instructions.ts` contains server-wide MCP instructions for cross-tool workflows.
- `src/register.ts` creates the MCP server and registers tools.
- `src/contracts/*` contains Zod input and output contracts.
- `src/tools/contracts.ts` is the single tool-name to contract map.
- `src/tools/catalog.ts` is metadata plus handler wiring only.
- `src/tools/define-tool.ts` converts contract objects to MCP SDK schemas and registers metadata.
- `src/tools/handlers.ts` contains thin adapters from tool input to services.
- `src/services/*` contains filesystem, git, search, tree, read, write, project, task, decision, and advisory planning logic.
- `src/policies/*` contains shared limits, excludes, write defaults, and secret patterns.
- `src/runtime/*` contains context, structured errors, result envelopes, and audit logging.

## Tool Registration Flow

The intended flow is:

```text
contracts -> toolContracts -> catalog -> define-tool -> handlers -> services
```

Contracts define schemas. `toolContracts` assigns exactly one input and output contract to each tool. `catalog` adds titles, descriptions, annotations, and handlers. `define-tool` is the only layer that turns Zod objects into MCP SDK `inputSchema` and `outputSchema` shapes. Handlers resolve approved repos and call services.

This keeps `catalog` metadata-only and prevents inline schema drift.

## Data Flow

ChatGPT calls a tool with `repo_id` and repo-relative POSIX paths or globs. The handler resolves `repo_id` through `RootRegistry`, creates the required services, and returns a result envelope.

Read filesystem access goes through shared safety layers:

```text
PathSandbox -> IgnoreEngine -> FileClassifier -> SecretScanner/FileReader
```

Write filesystem access stays separate from read services:

```text
PathSandbox -> WritePolicy -> FileWriter
                         \-> WriteChangesService -> FileWriter
write handlers -> OperationReceiptService
```

`repo_write_file` has its own contract, write annotations, repo-level policy, and service. The handler only resolves `repo_id`, builds the sandbox and write policy, and delegates to `FileWriter`.

`repo_write_changes` is the multi-file writer and edit-pack applier. It has its own contract and handler, applies ordered changes through `FileWriter`, and inherits the same repo-local path validation, write policy, symlink, unsupported file type, UTF-8 edit target, hard-risk secret path, resulting-content secret scan, and atomic per-file write guardrails. Grouped same-file edits read one existing file, apply exact-match nested edits in memory, and write once only after every nested edit succeeds. It does not stage, commit, restore, reset, or run shell commands; Git review and recovery workflows are the safety layer after a successful edit pack.

`OperationReceiptService` writes lightweight local receipt metadata after successful actual changed write operations and reads it through `repo_last_write`. Receipts live at `.chatgpt/operations/last-write.json`, are ignored by Git, and contain only safe metadata such as repo-relative paths, counts, timestamps, best-effort HEAD SHAs, and summaries. They do not store contents, snippets, diffs, prompts, command output, secrets, or absolute paths.

Read-only git status and diff operations are owned by `GitService`. Safe local git staging, one-call reviewed stage-and-commit, commit, and explicit worktree restore operations are separate opt-in mutating tools with their own contracts, policy checks, and service logic. Advisory services call existing factual services where practical instead of bypassing repo policy.

Git recovery is separate from write tools. `repo_write_file` and `repo_write_changes` write files only. `repo_write_recover` is the reviewed composite recovery helper: after `expected_head_sha` verification it can unstage explicit paths, restore explicit tracked worktree paths, and clean explicit generated artifacts through cleanup policy in one approved call. `repo_git_restore_paths` remains the granular worktree-only restore tool with fixed `git restore -- <paths>` arguments; it does not unstage, stage, commit, reset, checkout, clean, stash, restore the whole repo, or run shell commands.

`repo_git_review` remains read-only, but it is the workflow hub after write operations. It classifies changed paths and returns ready-to-run payloads for composite `repo_write_stage_commit` and `repo_write_recover` workflows, plus granular explicit worktree restore, cleanup-eligible generated untracked paths, unstage, stage, and commit operations without executing any of them. When staged paths exist, it adds guidance that granular restore is worktree-only while `repo_write_recover` can explicitly unstage and restore the same reviewed path in one approved call.

The preferred high-level mutation flow is `repo_git_review` followed by the review-provided `repo_write_stage_commit` or `repo_write_recover` payload after explicit user approval. Granular tools remain available for specific requested operations, staged-only commits, troubleshooting, or cases where composite payloads are absent.

## Advisory Planning Workflows

The advisory tools are read-only:

- Onboarding/daily planning: `repo_project_brief` -> `repo_task_inventory` -> `repo_next_action`
- Project memory: `repo_decision_memory`
- Implementation/refactor/debug planning: `repo_decision_memory` when conventions matter -> `repo_change_plan` -> targeted `repo_search`/`repo_fetch_file`/`repo_read_many`
- Current-change review: `repo_git_status` -> `repo_git_diff`
- Broad or ambiguous review: `repo_plan_review` before broad reading

`repo_next_action` recommends next work; it does not execute tests. `repo_change_plan` proposes implementation steps; it does not write files.

## Adding a Tool

Add a new tool by following the contract-first path:

1. Add input and output Zod objects under `src/contracts/*`.
2. Add the tool entry to `src/tools/contracts.ts`.
3. Add a concise `Use this when...` description in `src/tools/descriptions.ts`.
4. Add metadata and the handler reference in `src/tools/catalog.ts`.
5. Add a thin handler in `src/tools/handlers.ts`.
6. Put real logic in a service under `src/services/*`.
7. Add service tests, MCP contract coverage, tool contract discipline tests, and golden prompts when routing changes.

Do not duplicate path validation, ignore handling, secret scanning, schema definitions, or result envelope logic inside individual tools.

## Mutating Tools

Mutating tools are disabled by default per repository and must be enabled through explicit repo-local policy. `repo_write_file` can write or exact-match edit one file inside configured allowed globs and outside configured denied globs. `repo_write_changes` applies the same write/edit semantics to an ordered multi-file edit pack and supports grouped same-file exact-match edits without allowing duplicate top-level paths.

Mutating tools must stay separate from read tools. Do not loosen read services to support mutation, do not add shell execution, and do not add broad git automation. Safe git tools stage explicit paths, unstage explicit paths, restore explicit worktree paths, or create a local commit from an exact staged path list only after policy and HEAD checks. Cleanup tools remove only explicit generated artifacts allowed by cleanup policy.
