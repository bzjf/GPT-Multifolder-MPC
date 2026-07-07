# 测试流程

这个仓库的默认验收对象是 gpt-repo-mcp。在 Windows PowerShell 里优先用 npm.cmd，避免 npm.ps1 被执行策略拦截。

## 每次修改后的初检

```powershell
npm.cmd --prefix gpt-repo-mcp run verify
```

这条命令会依次执行：

1. typecheck：检查 TypeScript 类型。
2. build：确认 MCP server 和 CLI 能打包。
3. test:smoke：跑 MCP contract、tool contract、核心文件读取/分页安全测试。

初检通过，基本可以判断没有把 MCP 工具入口、schema、构建和核心读取路径改坏。

## 提交前全量检查

```powershell
npm.cmd --prefix gpt-repo-mcp run verify:full
```

这条命令会在 typecheck 和 build 后运行完整 Vitest 套件。

## 定位失败

先看失败属于哪一层：

- 类型失败：先修 tsc --noEmit 报错。
- 构建失败：检查入口、导入路径、Node ESM 输出。
- contract 失败：通常是 MCP 工具名、schema、描述或返回结构变了，需要同步契约测试。
- 单测失败：优先跑失败文件，例如 
`npm.cmd --prefix gpt-repo-mcp test -- tests/file-reader.test.ts`。

不要先跑交互式服务或隧道来判断代码是否健康；先让 verify 过。

