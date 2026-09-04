# 网页手动测试案例

先在控制面板启动一个 MCP 实例，确认显示“MCP：已就绪”，然后在页面底部的“本机 MCP 手动测试”区域选择工具并粘贴参数。

将下面的 `<repo_id>` 替换为实例对应的仓库 ID。

## 1. 列出仓库

工具：`repo_list`

```json
{}
```

预期：成功返回仓库列表，其中包含当前实例的 `repo_id`。

## 2. 查看目录树

工具：`repo_tree`

```json
{
  "repo_id": "<repo_id>",
  "include_files": true,
  "max_depth": 2,
  "page_size": 100
}
```

预期：返回目录和文件条目；条目过多时提供分页信息，而不是报参数缺失。

## 3. 搜索代码

工具：`repo_search`

```json
{
  "repo_id": "<repo_id>",
  "query": "README",
  "mode": "literal",
  "max_results": 20
}
```

预期：返回匹配路径和精确的 1-based 行号。不要给 `repo_search` 发送空对象，它必须包含 `repo_id` 和 `query`。

## 4. 读取文件行

工具：`repo_fetch_file`

```json
{
  "repo_id": "<repo_id>",
  "path": "README.md",
  "start_line": 1,
  "end_line": 20
}
```

预期：返回第 1 至 20 行；`start_line` 和 `end_line` 都是 1-based，且 `end_line` 包含在结果中。

## 5. 组合编辑上下文

工具：`repo_edit_context`

```json
{
  "repo_id": "<repo_id>",
  "goal": "检查 README 中的本机测试说明",
  "search_queries": ["本机手动测试"],
  "known_paths": ["README.md"],
  "max_search_results_per_query": 10,
  "max_files_to_read": 5
}
```

预期：一次返回搜索结果、候选文件和文件内容，且没有 input validation error。

## 判定可用

以上五项均能返回结构化结果，即可确认“网页 → 控制面板同源接口 → 本机 MCP server”的只读链路可用。写工具需要 write 或 ship 模式，并应先使用 `dry_run: true`。
