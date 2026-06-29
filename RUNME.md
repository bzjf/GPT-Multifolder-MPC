# GPT Repo MCP 

## 1. 推荐用法

现在推荐只用网页控制台启动和管理 MCP：

```bat
start-gpt-repo-control-panel.cmd
```

打开控制台：

```text
http://127.0.0.1:8790
```

控制台会同时启动两类本地服务：

```text
Panel: 127.0.0.1:8790   # 管理网页
Proxy: 127.0.0.1:8800   # 统一 MCP 反向代理入口
```

网页里只需要做四步：

1. 填目录路径。
2. 选择 `read` / `write` / `ship`。
3. 本地端口可以留空，自动分配。
4. 点击“保存目录”，然后点击该实例的“启动”。

启动成功后，该实例行会显示：

```text
URL
mcp_code
log 路径
```

把这一行显示的 URL 填到 GPT / ChatGPT Connector，调用工具时使用同一行显示的 `mcp_code`。

---

## 2. 现在填给 GPT 的 URL 是什么？

现在只有一个统一公网入口：

```text
Tailscale Funnel -> 本地 Proxy: 8800 -> 多个 MCP 实例
```

所以填给 GPT 的 URL 应该是：

```text
https://你的设备名.你的tailnet.ts.net/t/<path-code>/mcp
```

例如：

```text
https://my-pc.my-tailnet.ts.net/t/AbCdEf123456/mcp
```

这个 URL 通常是稳定可复用的。

规则是：

```text
同一个目录路径 -> 同一个 path-code
同一个设备名 + 同一个 tailnet + 同一个 Funnel 端口 -> 同一个公网 URL
```

因此，只要你没有换目录路径、没有换 Tailscale 设备名、没有换 tailnet 域名、没有换 Funnel 端口，填给 GPT / ChatGPT Connector 的 URL 一般不会变。重启 panel 或重启 MCP 实例后，通常不需要重新改 Connector URL。

会变化的是 `mcp_code`。每次启动实例都会生成新的 `mcp_code`，所以重启后需要复制新的 `mcp_code` 给工具调用使用。

如果统一 Funnel 使用的不是默认 `443`，而是 `8443` 或 `10000`，URL 需要带端口：

```text
https://你的设备名.你的tailnet.ts.net:8443/t/<path-code>/mcp
```

注意：不要把具体 MCP 实例端口填给 GPT，例如不要填：

```text
http://localhost:8788/t/<path-code>/mcp
```

现在 GPT 应该连统一 Proxy 对外暴露出来的 URL。

---

## 3. mcp_code 怎么用？

`mcp_code` 是工具调用级别的访问码。

它和 URL 里的 path-code 不是一个东西：

| 名称 | 出现位置 | 作用 |
|---|---|---|
| path-code | URL 里：`/t/<path-code>/mcp` | 让 Proxy 找到对应的 MCP 实例 |
| `mcp_code` | 工具参数里 | 允许真正调用受保护工具 |

除 `codex_list_skills` 外，受保护工具调用都需要带当前实例显示的 `mcp_code`。

示例：

```json
{
  "repo_id": "gpt-mcp",
  "path": "RUNME.md",
  "mcp_code": "当前实例显示的 mcp_code"
}
```

如果报：

```text
ACCESS_CODE_INVALID
```

说明 `mcp_code` 不对，重新复制当前实例那一行的 `mcp_code`。

---

## 4. 三类端口的区别

| 端口 | 作用 | 示例 |
|---|---|---|
| Panel 端口 | 网页控制台，只负责管理实例 | `127.0.0.1:8790` |
| Proxy 端口 | 统一 MCP 反向代理入口 | `127.0.0.1:8800` |
| MCP 实例端口 | 真正的 gpt-repo-mcp server，每个目录一个 | `127.0.0.1:8788`、`8789`、`8791` |

一句话：

```text
8790 = 管理网页
8800 = 统一 MCP 入口
8788/8789/... = 每个目录背后的真实 MCP server
```

---

## 5. 技术路线

当前设计是：一个统一 Funnel，转发给本机一个统一 Proxy，再由 Proxy 分流给多个 MCP server。

```text
GPT / ChatGPT
  ↓
https://你的设备名.ts.net/t/<path-code>/mcp
  ↓
Tailscale Funnel: 443
  ↓
本地 Proxy: 127.0.0.1:8800
  ↓ 按 /t/<path-code>/mcp 分流
MCP 实例 A: 127.0.0.1:8788
MCP 实例 B: 127.0.0.1:8789
MCP 实例 C: 127.0.0.1:8791
```

关键变化：

```text
Funnel 不再直接转发到 8788/8789。
Funnel 只转发到 8800。
8800 再根据 /t/<path-code>/mcp 分流到不同 MCP 实例。
```

这样做的好处：

- 只需要一个 Funnel 公网入口。
- 多个目录可以共用同一个公网域名。
- 不需要为每个 MCP 实例占一个 Funnel 端口。
- GPT 侧 URL 结构稳定，只是 path-code 不同。

---

## 6. 多目录使用流程

1. 启动控制台：

```bat
start-gpt-repo-control-panel.cmd
```

2. 打开：

```text
http://127.0.0.1:8790
```

3. 添加目录。
4. 选择模式。
5. 点击“保存目录”。
6. 点击“启动”。
7. 复制该行显示的 URL 和 `mcp_code`。
8. 在 GPT / ChatGPT Connector 中填写 URL。
9. 调工具时带上该实例的 `mcp_code`。

---

## 7. 模式说明

| 模式 | 用途 |
|---|---|
| `read` | 只读分析代码 |
| `write` | 允许修改文件 |
| `ship` | 更高权限，包含 stage / commit / cleanup 等流程 |

日常改代码建议用 `write`。

---

## 8. 日志位置

每个实例都有自己的日志：

```text
.runtime/control-panel/instances/<instance-id>/server.log
```

网页实例行会显示具体日志路径。

---

## 9. 补充：stable.cmd

`start-gpt-repo-mcp-stable.cmd` 仍然可以作为单目录快速启动入口，但它不属于推荐主流程。

stable 和 panel 是不同入口：

```text
stable 启动的 MCP 实例，不会自动登记到 panel 的运行状态里。
panel 只知道自己启动的实例。
```

如果要使用统一 Proxy / 统一 Funnel / 多实例管理，请使用：

```bat
start-gpt-repo-control-panel.cmd
```

---

## 10. 常见问题

### Panel 显示已停止，但 stable 明明启动了

正常。stable 和 panel 是不同入口。要统一管理，就关闭 stable，在 panel 里点“启动”。

### 开多个目录需要多个 Funnel 吗？

不需要。现在是：

```text
一个 Funnel -> 一个本地 Proxy -> 多个 MCP server
```

### 看不到工具调用日志

正常。详细日志写到 `.runtime/` 下，避免窗口刷屏。
