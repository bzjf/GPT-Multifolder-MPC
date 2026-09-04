# 测试

这是仓库唯一的测试根目录。自动化测试、共享夹具和可复制的手动测试案例都放在这里；`src/` 和 `scripts/` 不存放测试文件。

## 目录结构

```text
tests/
├─ server/                 # MCP server 的 Vitest 测试
│  ├─ fixtures/            # server 测试共享仓库夹具
│  ├─ helpers/             # server 测试帮助代码
│  └─ *.test.ts
├─ control-panel/          # 控制面板的 node:test 测试
│  ├─ *.test.mjs
│  └─ test-all.mjs         # control-panel 聚合入口
├─ manual/                 # 网页控制面板手动调用案例
└─ README.md               # 本文件，唯一测试说明入口
```

## PowerShell 命令

在仓库根目录执行：

```powershell
# 快速验收：类型、构建、控制面板和 MCP smoke tests
npm.cmd --prefix gpt-repo-mcp run verify

# 全量 server 测试
npm.cmd --prefix gpt-repo-mcp test

# 单个 server 测试
npm.cmd --prefix gpt-repo-mcp test -- tests/server/file-reader.test.ts

# 控制面板测试
npm.cmd --prefix gpt-repo-mcp run test:control-panel

# 提交前完整验收
npm.cmd --prefix gpt-repo-mcp run verify:full

# TypeScript 与控制面板 lint
npm.cmd --prefix gpt-repo-mcp run lint
```

Vitest 只收集 `server/**/*.test.ts`；控制面板测试由 `node:test` 独立执行，避免两个 runner 重复收集同一文件。

## 测试范围

- `server/`：MCP 协议、工具 schema、文件读写、路径和密钥策略、Git 工作流、Codex 交接、配置与遥测。
- `control-panel/`：本机 MCP initialize、tools/list、tools/call、SSE/JSON、超时和 session 回收，以及实例、Funnel、端口和 HTTP 页面安全。
- `manual/`：真实启动本机实例后，通过网页手动输入参数验证端到端可用性。

定位失败时先运行对应的单文件或单套件测试，再运行 `verify:full`。不要用交互式服务或公网隧道替代自动化验收。
