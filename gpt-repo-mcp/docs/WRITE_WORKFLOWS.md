# Write Workflows

Manual config remains supported for teams that prefer editing JSON directly.

```json
{
  "repos": [
    {
      "repo_id": "example",
      "display_name": "Example Repo",
      "root": "/absolute/path/to/repo"
    }
  ]
}
```

## Line-number edits

For an existing text file, read the target range first and copy the returned 1-based line numbers unchanged into `repo_write_file` or `repo_write_changes`. `end_line` is inclusive, and a final newline character does not create another editable line.

```json
{
  "repo_id": "example",
  "path": "src/app.ts",
  "action": "replace_lines",
  "start_line": 12,
  "end_line": 14,
  "content": "export const enabled = true;\n"
}
```

When one file has multiple line edits, all coordinates refer to the same original pre-edit snapshot. The server validates that the ranges do not overlap and applies them bottom-up, so an earlier insertion cannot shift a later target.

```json
{
  "repo_id": "example",
  "changes": [
    {
      "type": "edit",
      "path": "src/app.ts",
      "edits": [
        {
          "type": "insert_before_line",
          "start_line": 5,
          "content": "const started = true;\n"
        },
        {
          "type": "replace_lines",
          "start_line": 20,
          "end_line": 22,
          "content": "return result;\n"
        }
      ]
    }
  ]
}
```

Do not mix line-number and exact-text edits in the same grouped file edit. Exact `find`/`replace` operations remain a fallback only when current line numbers are unavailable; do not place unified diffs or `apply_patch` text inside MCP arguments.
