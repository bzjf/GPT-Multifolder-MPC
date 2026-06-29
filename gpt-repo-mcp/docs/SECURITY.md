# Security

## Tool Annotations

Read tools use read-only annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`
- `idempotentHint: true`

Mutating tools use separate write annotations:

- `readOnlyHint: false`
- `destructiveHint: true`
- `openWorldHint: false`
- `idempotentHint: false`

No shell execution tools, arbitrary command runners, direct Codex execution tools, push/pull/reset/checkout/switch/rebase/merge/stash/clean tools, force operations, or branch deletion tools are registered. Safe local git staging and commit tools use fixed `git` argument arrays through `execFile`; they are not arbitrary git command runners. Advisory tools such as `repo_change_plan` and `repo_next_action` return plans and recommendations only; they do not write files or run tests.

Codex task tools do not run Codex or execute commands. `repo_prepare_codex_task` renders a prompt in tool output, `repo_write_codex_task` writes local prompt metadata under `.chatgpt/codex-runs/` through the normal write policy, and `repo_codex_review` reads the run result plus git review state. The user remains responsible for running Codex separately.

## Transport

The default OSS connection path is `npm run connect`. It starts the local MCP server and starts or reuses ngrok as a built-in convenience HTTPS tunnel. The printed ChatGPT URL ends in `/t/<random-token>/mcp`. See [CONNECTION_OPTIONS.md](CONNECTION_OPTIONS.md) for built-in, manual, and Secure MCP Tunnel connection paths.

That random path token is guess-resistance only, not authentication. Anyone with the full URL can reach the MCP endpoint while the public tunnel is running, so treat it as a temporary local development endpoint and stop it when done.

Network exposure does not bypass repository policy. ChatGPT still supplies only `repo_id`; approved roots, default excludes, path sandboxing, secret checks, read/write policies, expected HEAD checks, and tool schemas still apply. Mutating tools remain disabled unless the target repo explicitly enables writes or operations.

OpenAI Secure MCP Tunnel is an advanced option for longer-lived or private connector setups when supported. In that mode, the local MCP endpoint stays private at `/mcp`, while `tunnel-client` opens an outbound connection to OpenAI and forwards MCP requests back to the local server. Store the tunnel runtime API key in `.env` or another local secret store, never in committed files.

## Approved Roots

ChatGPT never supplies absolute repository paths. It supplies `repo_id`; the server resolves that id to an approved root from config. Unknown repos are rejected.

All model-supplied paths must be repo-relative POSIX paths. `PathSandbox` rejects absolute paths, traversal, symlink escapes, device files, sockets, and named pipes.

## Default Excludes

Default excludes apply consistently to tree, search, bounded reads, project briefing, task inventory, decision memory, change planning, and next-action signals. Common excluded areas include Git internals, dependency directories, generated output/cache directories, coverage, virtual environments, and generated test artifacts.

Generated/default-excluded files can be fetched only through `repo_fetch_file` with `override_default_excludes: true`, and the result includes a warning. Secret candidates remain blocked.

## Secret Candidates

Secret-looking paths are blocked by default, even when explicitly requested. Sensitive examples include `.env`, private keys, certificate bundles, identity key files, and directories exactly named `secrets` or `credentials`. Ordinary code, docs, and tests are not blocked merely because their paths contain words like `secret` or `credential`.

Public environment templates are the narrow exception for reads: `.env.example`, `.env.sample`, `.env.template`, and `example.env` can be read when their contents pass secret scanning. Real environment files such as `.env`, `.env.local`, `.env.production`, and arbitrary `.env.*` names remain blocked.

Tool outputs, errors, and logs must not include file contents from blocked secret candidates, tokens, credentials, environment variables, private keys, raw tool outputs, or raw errors. Except for the configured `root` returned by `repo_list_roots`, tools should prefer `repo_id` and repo-relative paths over absolute paths.

## Write Policy

Writes are disabled by default for every repo. A repo must opt in with `writes.enabled: true`.

The CLI permission modes are config shortcuts only:

- `read`: writes and operations disabled.
- `write`: broad repo-local file edits enabled under write policy, with hard denied paths and secret checks still enforced.
- `ship`: write mode plus local git stage, commit, recover, and cleanup operations.

No mode enables shell execution, arbitrary command execution, push, pull, reset, checkout, switch, rebase, merge, stash, clean, force, or branch deletion.

Default allowed write globs are `.chatgpt/**`, `.codex/**`, `docs/**`, exact root public docs (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `LICENSE`), and exact `.gitignore`. This is not a general root-write allowance; root files such as `package.json`, source files, scripts, tests, and arbitrary notes remain blocked unless the repo opts in with custom allow globs. The `.gitignore` allowance is a narrow repo-metadata path for adding local-only ignore policy. Default denied write globs include real env files, private key files, Git internals, root and nested dependency directories, common generated/cache directories, coverage, test results, and virtual environments. Denied globs and hard secret-candidate checks win over allowed globs.

Clone-based `npm run add -- <path> --mode write` and `--mode ship` intentionally use `allowed_globs: ["**"]` for solo-dev ergonomics while preserving the hard denied globs, hard secret-path checks, resulting-content secret scans, path sandboxing, and size limits. Use `repo_policy_explain` to inspect the effective read/write/cleanup policy and explain why a supported path check is allowed or blocked.

`repo_write_file` also enforces repo-relative paths, no traversal, no absolute paths, no symlink escapes, no device files, no sockets, no named pipes, `max_bytes_per_write`, denied globs, allowed globs, and secret scanning of the resulting content. `dry_run: true` performs policy, path, size, and content checks and computes the result without writing.

`repo_write_file` does not create visible overwrite backups by default. Its result includes `old_sha256` and `new_sha256` for review, but the user-facing write flow no longer requires manually supplying `expected_sha256`.

## Operations Policy

Local git operations are disabled by default for every repo. A repo must opt in with `operations.enabled: true`, `operations.git_stage_enabled: true`, and `operations.git_commit_enabled: true` as appropriate.

`repo_git_stage` and `repo_git_unstage` accept only explicit repo-relative POSIX paths and require `expected_head_sha`. They reject empty path lists, `.`, `*`, shell-like pathspecs, absolute paths, traversal, `.git`, real environment files, private key/certificate files, identity key filenames, and directories literally named `secrets` or `credentials`. Legitimate code, docs, and tests whose filenames contain words like `secret` or `credential` are allowed when the path is explicit and otherwise safe. Actual staging uses fixed `git add -- <paths>` arguments, and actual unstaging uses fixed `git restore --staged -- <paths>` arguments.

Public environment template files can be staged only through a narrow filename allowlist: `.env.example`, `.env.sample`, `.env.template`, and `example.env`. These files are still read and scanned for secret-looking values before staging or commit validation. Real environment files such as `.env`, `.env.local`, and `.env.production` remain blocked.

`repo_git_commit` requires `expected_head_sha`, a non-empty message, and non-empty `expected_staged_paths`. It verifies actual staged paths exactly match the expected list before using fixed `git commit -m <message>` arguments. It does not stage files, use `git commit -a`, or push.

`repo_cleanup_paths` is disabled by default and requires both `operations.enabled: true` and `operations.cleanup_enabled: true`. It deletes only explicitly listed repo-relative paths that match `operations.cleanup_allowed_globs` and refuses targets tracked by Git. Defaults are `.chatgpt/tool-tests/**`, `.chatgpt/backups/**`, `.chatgpt/audits/**`, `.chatgpt/backlog/**`, `.chatgpt/codex-runs/**`, `coverage/**`, `dist/**`, and `test-results/**`. It rejects absolute paths, traversal, `.`, `*`, broad pathspec-like values, `.git`, `.env`, secret-looking paths, symlink escapes, device files, sockets, and named pipes. Deletion uses Node filesystem APIs only and never runs `git clean`.

## Nested Repos and Submodules

Nested Git repositories and submodules are separate trust boundaries. Tree/search/read_many/planning workflows do not recurse into them by default. Register a nested repo or submodule as its own `repo_id` to allow reading it.

Symlinks are still resolved through the sandbox, so a symlink cannot be used to escape the approved root or bypass nested-repo boundaries.

## Error Envelope

All tool errors use the shared structured error envelope through the MCP error path:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Sanitized message",
    "retryable": false,
    "diagnostics": []
  }
}
```

Validation errors identify the invalid field without echoing sensitive values. Policy errors distinguish blocked secret candidates, default-excluded paths, traversal attempts, symlink escapes, binary files, and size limits where possible. Unexpected errors are converted to sanitized internal errors before returning to ChatGPT.

## Audit Logging

Audit logs may include tool name, `repo_id`, safe repo-relative paths or globs, counts, truncation state, warning codes, `request_id`, safe MCP method and tool name, HTTP status code, duration, and MCP session presence.

Audit logs must not include request bodies, tool arguments, full MCP session ids, headers, returned file text, file content, secret-looking values, raw structured outputs, raw errors, environment variables, tokens, credentials, SSH keys, private keys, or unredacted absolute paths.

`GPT_REPO_CONFIG`, `GPT_REPO_PUBLIC_PATH_TOKEN`, `GPT_REPO_LOG_FORMAT`, and `GPT_REPO_LOG_COLOR` are the public environment variables. Legacy `REPO_READER_*` names remain supported as fallback aliases for compatibility.

`GPT_REPO_LOG_FORMAT=pretty` changes only terminal formatting. Pretty logs use the same sanitized audit event data as the default JSON logs. `GPT_REPO_LOG_COLOR=auto|always|never` controls color, and `NO_COLOR` disables color.
