# GPT Repo MCP

GPT Repo MCP 是一个用于把代码仓库接入 ChatGPT 的 MCP 管理工具。

它提供一个网页控制面板。你可以在控制面板里添加代码仓库、启动 MCP 实例，并把生成的 URL 填到 ChatGPT Connector。连接成功后，ChatGPT 就可以在你允许的权限范围内读取代码、分析项目、修改文件、检查 git diff，或辅助整理提交。

本项目是基于 gpt-repo-mcp https://github.com/CAHN91/gpt-repo-mcp 的非官方二次开发版本，详见 NOTICE.md。

---

## 功能

- 通过网页控制面板管理多个代码仓库
- 为每个仓库生成独立的 Connector URL
- 支持 read、write、ship 三种权限模式
- 支持启动、停止、删除实例
- 支持查看 Node.js 端口占用
- 支持通过弹窗选择文件夹

---

## 安装与启动

先安装 Node.js 20 或更高版本，并确认 npm 可以在命令行中直接运行。

如果要让 ChatGPT Connector 访问这台电脑上的 MCP 服务，需要先完成两件事。
第一，在电脑上安装 Tailscale 客户端并登录账号。
第二，在 Tailscale 管理后台允许这个 tailnet 使用 Funnel，也就是在 Access controls 里的 Funnel 区域把 Funnel 加到策略里。这个是 Tailscale 后台权限开关，不是在本项目控制面板里打开。

后台允许 Funnel 之后，本项目控制面板在启动实例时会尝试调用 Tailscale Funnel，把控制面板的代理入口暴露成 HTTPS URL。没有 Funnel 时，控制面板仍然可以打开，但 ChatGPT 端通常无法访问你的电脑服务。

首次使用时，进入 gpt-repo-mcp 目录，执行 npm install 安装依赖，然后回到项目根目录。

之后在项目根目录双击或运行 start-gpt-repo-control-panel.cmd。

启动后浏览器会打开控制面板。默认地址是 http://127.0.0.1:8790。

平时启动直接运行启动脚本即可。

---

## 默认端口和修改方式

这些默认值只是程序里的默认回退值：启动时如果没读到对应环境变量，就使用默认端口。也就是说，不改任何东西时会用默认值；临时设置环境变量时，只影响这一次启动；写进启动脚本时，才会变成每次双击都生效。

当前主流程涉及四类端口。

| 端口 | 默认值 | 作用 | 修改方式 |
|---|---:|---|---|
| 控制面板端口 | 8790 | 浏览器访问控制面板 | 临时设置 GPT_REPO_PANEL_PORT，或写入启动脚本 |
| Proxy 端口 | 8800 | 接收 Funnel 转发请求，再分发到具体 MCP 实例 | 临时设置 GPT_REPO_PROXY_PORT，或写入启动脚本 |
| 实例端口 | 自动分配，通常从 8789 开始递增 | 每个仓库实例实际运行 MCP 服务 | 添加实例时填写“实例端口”；留空则自动分配 |
| Funnel HTTPS 端口 | 443 | ChatGPT Connector 访问的 HTTPS 入口 | 修改 gpt-repo-mcp.config.json 里的 httpsPort，或增加 proxyHttpsPort |

控制面板端口是给浏览器看的，例如默认访问 http://127.0.0.1:8790。

Proxy 端口是给 Tailscale Funnel 转发用的。Funnel 通常把外部 HTTPS 请求转到这个 Proxy 端口，再由 Proxy 按 URL 路径分发到对应实例。

实例端口是每个仓库自己的 MCP 服务端口。这个端口一般不需要手动指定；多个仓库同时运行时，控制面板会自动给它们分配不同端口。



### 临时修改端口

临时修改适合偶尔换一次端口。它不会写入系统环境变量，只影响当前这个命令启动出来的控制面板。

在 Windows CMD 里，把控制面板端口改成 8791：
```
set "GPT_REPO_PANEL_PORT=8791" && start-gpt-repo-control-panel.cmd
```

在 PowerShell 里，把控制面板端口改成 8791：
```
$env:GPT_REPO_PANEL_PORT="8791"; .\start-gpt-repo-control-panel.cmd
```

Proxy 端口同理，把变量名换成 GPT_REPO_PROXY_PORT。例如在 PowerShell 里改成 8801：
```
$env:GPT_REPO_PROXY_PORT="8801"; .\start-gpt-repo-control-panel.cmd
```

关闭这个命令行窗口后，这种临时设置就没了。下次直接双击启动脚本，还是会回到脚本里写的值或程序默认值。

### 固定修改端口

固定修改适合以后每次双击启动脚本都使用新端口。它也不是写入系统环境变量，而是写进本项目的启动脚本。

打开 start-gpt-repo-control-panel.cmd，找到 set "GPT_REPO_PANEL_OPEN=1" 这一行，在它下面增加端口设置。

如果只改控制面板端口，就增加：
```
set "GPT_REPO_PANEL_PORT=8791"
```

如果还要改 Proxy 端口，再增加：
```
set "GPT_REPO_PROXY_PORT=8801"
```

保存后，之后双击 start-gpt-repo-control-panel.cmd 就会使用新端口。

### 修改实例端口

实例端口可以在控制面板添加仓库时填写“实例端口”。如果留空，控制面板会自动分配。

如果某个已有实例端口被占用，可以删除这个实例后重新添加，并填写一个未占用端口。

---

## 使用流程

### 1. 添加仓库

打开控制面板后，在“添加实例”区域选择或填写项目路径。

| 项目 | 说明 |
|---|---|
| 仓库路径 | 点击“选择文件夹”，或粘贴项目路径 |
| 模式 | 选择 read、write 或 ship |
| 实例端口 | 可以留空，系统会自动分配 |

点击“添加”。

### 2. 启动实例

在实例列表中找到刚添加的仓库，点击“启动”。

启动成功后，实例列表会显示对应的 URL。点击“复制 URL”。

### 3. 打开 ChatGPT 的开发者模式

在 ChatGPT 页面中，进入头像或左下角菜单里的 Settings。

找到 Connectors、Apps & Connectors 或类似入口。

进入 Advanced、Developer 或 Developer mode 区域，打开开发者模式。

打开后，页面中会出现用于添加自定义 Connector 或 MCP Connector 的入口。不同账号和版本的名称可能略有差异，但核心目标是找到“添加自定义连接器”这一类入口。

### 4. 添加 Connector URL

回到控制面板，复制实例列表里的 URL。注意要复制实例 URL，不是控制面板首页地址。

在 ChatGPT 的自定义 Connector 页面中，新建 Connector，把这个 URL 粘贴进去，然后保存。

如果 ChatGPT 页面提供测试、验证、刷新工具列表或重新连接按钮，保存后先点一次测试。测试通过后，ChatGPT 才能在聊天里发现这个 MCP 服务器暴露的工具。

### 5. 在聊天里启用并测试

新开一个聊天，在工具、连接器或应用列表里选择刚才添加的 Connector。

第一次测试建议使用 read 模式。发送“你能访问哪些仓库？”或者“列出当前可用的 MCP 工具”。

如果配置正常，ChatGPT 会返回可访问的仓库，或者显示这个 MCP 服务器暴露的工具列表。

### 6. 调试连接问题

如果添加失败，先检查控制面板里的实例是否是“运行中”。

如果 ChatGPT 提示无法访问 URL，优先检查 Tailscale 是否已登录、Tailscale 管理后台是否已经允许 Funnel、本项目控制面板是否已经成功生成 HTTPS URL，以及复制的 URL 是否是 HTTPS 地址。

如果 ChatGPT 能连接但看不到仓库，检查实例是否启动、权限模式是否选对、复制的是否是对应仓库那一行的 URL。

如果工具能看到但调用失败，先切回 read 模式测试读取能力，再逐步切换到 write 或 ship。

---

## URL 安全提醒⚠⚠⚠

实例 URL 是连接 MCP 服务的入口，应当按敏感信息处理。

当前版本的实例 URL 是稳定生成的（与原版gpt-repo-mcp不同），同一个仓库路径通常会得到固定 URL。它不会因为重启控制面板或重启实例就自动更换。这是因为Chatgpt的MCP服务器不支持中途更换URL地址。

因此，不要把 URL 发到公开聊天、公开仓库、截图、日志或文档里。不使用时，建议在控制面板里停止对应实例；长期不用时，可以删除 ChatGPT Connector 里的配置，并关闭 Tailscale Funnel。

权限模式只限制连接后的工具能力，不等于 URL 本身可以公开。尤其是 write 或 ship 模式，URL 泄露会带来更高风险。

---

## 权限模式

| 模式 | 适合场景 | 能力 |
|---|---|---|
| read | 只想让 ChatGPT 看代码 | 读取项目结构、搜索文件、阅读文件、查看 git 状态和 diff |
| write | 日常开发协助 | 包含 read，并允许 ChatGPT 在受控范围内修改文件 |
| ship | 准备提交或整理变更 | 包含 write，并允许提交整理、恢复修改、清理生成文件等操作 |

建议第一次连接时使用 read。确认没有问题后，再按需要切换到 write 或 ship。

---

## 技术路线

整体链路是：ChatGPT Connector → Tailscale Funnel HTTPS 入口 → 控制面板内置 Proxy → 按 URL 路径分发到对应 MCP 实例 → 指定代码仓库。

控制面板负责实例管理。用户在面板中添加仓库后，控制面板会为这个仓库分配实例端口，并在启动时拉起对应 MCP 服务。

Tailscale Funnel 负责把这台电脑上的服务暴露成 ChatGPT Connector 可以访问的 HTTPS 地址。外部请求先进入 Funnel，再转发到控制面板内置 Proxy。

Proxy 负责端口分发。每个仓库实例都有自己的端口；Proxy 根据 URL 中的路径标识找到对应实例，再把请求转发到这个实例。

MCP 实例负责真正暴露工具接口。ChatGPT 通过这些接口读取仓库、搜索文件、查看 diff、修改文件或整理提交。

权限模式负责控制工具边界。read 只允许读取和分析；write 允许受控写入；ship 允许进一步整理提交和恢复工作区。

---

## MCP 服务器能力接口

连接成功后，ChatGPT 会通过 MCP 工具接口访问仓库。下面是主要能力类型。

| 能力类型 | 作用 | 典型用途 |
|---|---|---|
| 仓库发现 | 查看当前可访问的仓库和基本状态 | 确认连接是否成功，确认 ChatGPT 能访问哪些项目 |
| 项目概览 | 读取 README、package 信息、目录信号和近期状态 | 快速理解项目用途、启动方式和当前状态 |
| 目录查看 | 查看仓库目录结构 | 判断项目结构，再决定要读哪些文件 |
| 文件搜索 | 按关键词或正则搜索代码和文档 | 找函数、配置、接口、报错信息、TODO |
| 文件读取 | 读取指定文件或多个文件 | 分析源码、解释配置、检查文档 |
| 修改计划 | 在不写文件的情况下给出修改方案 | 先评估改哪里、怎么改、有什么风险 |
| 文件修改 | 写入单个文件或应用一组精确修改 | 修改 README、修 bug、调整配置、重构小范围代码 |
| 变更审查 | 查看 git 状态和 diff，并总结风险 | 提交前检查改了什么，有没有误改 |
| Git 整理 | 整理暂存区、提交、恢复错误修改、清理生成文件 | 准备提交或恢复工作区 |
| 权限说明 | 解释某个路径为什么能读、能写或被拒绝 | 排查权限不足、路径被拦截、写入失败等问题 |
| 任务交接 | 生成代码代理任务、读取任务结果、复核 diff | 把较大的改动拆给代码代理执行，再由 ChatGPT 复核 |
| Codex 技能读取（新加） | 列出并读取本机已安装的 Codex skills | 让 ChatGPT 先理解本机 Codex 技能的用途和使用方式，再决定是否生成对应任务 |

不同权限模式下可用能力不同。read 适合阅读和分析；write 适合让 ChatGPT 修改文件；ship 适合整理提交和恢复工作区。

---

## 常见问题

### 为什么需要 Tailscale Funnel？

ChatGPT Connector 需要访问一个 HTTPS 地址。Tailscale Funnel 用来把这台电脑上的 MCP 服务暴露成可访问的 HTTPS 入口。

注意这里分两层：Tailscale 管理后台负责允许 Funnel；本项目控制面板负责在实例启动时使用 Funnel 生成可访问的 URL。后台没有允许 Funnel 时，控制面板无法单独完成这一步。

### 启动后没有自动打开浏览器怎么办？

手动访问 http://127.0.0.1:8790。

### URL 为什么默认隐藏？

URL 用于连接 ChatGPT Connector，属于敏感连接信息。控制面板默认会模糊显示，鼠标悬停或点击复制即可使用。

### ChatGPT 连接不上怎么办？

先确认控制面板里的实例状态是“运行中”，再确认复制的是实例列表里的 URL。如果使用需要外部访问的连接方式，还需要确认 Tailscale Funnel 正常工作。

### ChatGPT 使用的问题

ChatGPT 对MCP服务器单次请求大小有限制，所以有时候可能会调用失败/多次调用工具。属于正常现象。必要时可手动告诉ChatGPT不要一次性塞入太多文本。

同时 ChatGPT 对下发给 MCP服务器的请求有安全拦截，有时候不能调用可能是因为被 ChatGPT 侧拦截导致的。

---

## License

本项目整体采用 MIT License，详见 LICENSE。

本项目包含并修改了上游 gpt-repo-mcp 的代码；上游许可证声明保留在 gpt-repo-mcp/LICENSE，来源说明见 NOTICE.md。
