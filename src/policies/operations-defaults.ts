export const DEFAULT_OPERATIONS_POLICY = {
  enabled: false,
  git_stage_enabled: false,
  git_commit_enabled: false,
  max_paths_per_operation: 50,
  cleanup_enabled: false,
  cleanup_allowed_globs: [
    ".chatgpt/tool-tests/**",
    ".chatgpt/backups/**",
    ".chatgpt/audits/**",
    ".chatgpt/backlog/**",
    ".chatgpt/codex-runs/**",
    "coverage/**",
    "dist/**",
    "test-results/**"
  ]
};
