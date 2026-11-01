# Overleaf MCP

[English](README.md) | 简体中文

让支持 MCP 的助手连接你的 [Overleaf](https://www.overleaf.com/) 项目，读取实时 LaTeX 内容、修改源码、上传附件、查看评论和历史，并编译 PDF。

这是一个**非官方的实验性集成**。服务在本地通过 stdio 运行，使用 Overleaf 网页接口和实时连接。Overleaf 更新后，可能需要同步调整本项目。

## 支持的功能

| 类别 | 功能 |
|---|---|
| 项目 | 列出可访问项目，查看文件、文件夹和主文件设置 |
| 实时读取 | 读取完整文本或指定行，监听变化并发送 MCP 资源通知 |
| 源码修改 | 创建文本文件、精确替换或写回完整文本，检查文档 ID 和版本 |
| 上传 | 上传本地文本、图片、PDF 等文件，可选择覆盖同名文件 |
| 下载 | 下载单个文件、完整源码 ZIP 和可访问的历史版本 |
| 历史 | 查看修改记录、版本标签、文件树差异和文本差异 |
| 协作 | 查看受邀成员和在线用户 |
| Review | 读取与创建批注；回复、编辑和删除消息；解决、重新打开和删除线程；接受与拒绝修订 |
| 编译 | 使用官方或本地编译器，获取 PDF 和日志，在官方超时或服务故障时回退到本地 |

使用有权访问项目的免费 Overleaf 账号即可开始。可用的历史、Review 操作和编译能力遵循 Overleaf 返回的账号与项目权限。

## 快速开始

需要准备：

- Node.js **22 或更新版本**、npm 和 Git。
- 本机已安装 Google Chrome。
- 一个有权访问目标项目的 Overleaf 账号。
- 仅本地编译需要：`latexmk` 和对应 TeX 引擎，可由 MacTeX 或 TeX Live 提供。

### 直接从 GitHub 运行

使用 `npx` 自动下载、构建并运行服务：

```sh
npx --yes git+https://github.com/vvbbnn00/overleaf-mcp.git login
```

Git 安装通过 npm 运行构建脚本，已通过 npm 10 测试。源码安装便于直接管理依赖安装与构建步骤。

在浏览器窗口中手动登录并完成验证。登录成功后，程序会保存会话、关闭浏览器并退出命令。随后 MCP 客户端即可使用已保存的会话。

检查已保存的会话：

```sh
npx --yes git+https://github.com/vvbbnn00/overleaf-mcp.git status
```

### 接入 MCP 客户端

对于使用 `mcpServers` 配置格式的客户端，可以添加：

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["--yes", "git+https://github.com/vvbbnn00/overleaf-mcp.git", "serve"]
    }
  }
}
```

登录命令与服务默认共用 `~/.overleaf-mcp`。请确保 MCP 客户端的 `PATH` 中包含 `npx` 和 Node，或直接配置 `npx` 的完整路径。配置格式以客户端要求为准。

MCP 客户端启动服务，并通过 stdio 与其通信。

### 从源码安装

开发或需要固定的本地安装时，可以运行：

```sh
git clone https://github.com/vvbbnn00/overleaf-mcp.git
cd overleaf-mcp
npm ci
npm run build
npm run login
```

采用此方式时，将 MCP 命令设为 `node`，参数设为 `["/absolute/path/to/overleaf-mcp/dist/cli.js", "serve"]`，并替换为仓库的实际路径。可用 `npm run dev -- status` 检查会话。

## 使用方式

先用 `list_projects` 获取项目 ID，再用 `get_project` 查看文件和文件夹。你可以让助手：

- 读取 `main.tex` 并解释其中一节。
- 替换指定段落，保留周围内容。
- 将图片上传到项目中已有的文件夹。
- 查看待处理批注及其源码位置。
- 编译项目并打开生成的 PDF。

### 修改源码

先读取文件，将返回的 `docId` 和 `version` 作为 `expectedDocId`、`expectedVersion` 传给 `write_file` 或 `replace_text`。

`replace_text` 将修改限定于 `oldText` 的唯一精确匹配处。`write_file` 先按行比对，再应用局部字符编辑。两者均随正文修改同步更新受影响的批注范围，并保留线程 ID、回复和解决状态。Overleaf 可合并并发编辑。

返回结果分别说明：

| 字段 | 含义 |
|---|---|
| `applied` | Overleaf 已确认应用修改 |
| `verified` | 后续读取的文档 ID 一致，且版本达到或超过确认值 |
| `matchesRequestedContent` | 实际文本与请求内容一致 |

遇到 `VERSION_CONFLICT` 时，重新读取文件。遇到 `WRITE_STATUS_UNKNOWN` 时，重新连接 MCP 服务并检查文档，再决定是否重试。出现这个错误后，原连接会阻止继续写入该文档。

### 上传文件

`upload_file` 的参数示例：

```json
{
  "projectId": "PROJECT_ID",
  "localPath": "/absolute/path/to/figure.png",
  "path": "figures/figure.png",
  "overwrite": false
}
```

将 `PROJECT_ID` 和文件路径替换为实际值。`localPath` 指的是运行 MCP 服务的机器上的文件。目标文件夹需要已经存在；省略 `path` 时，会使用本地文件名上传到项目根目录。

- `overwrite: false` 保留已有文件，上传时需指定新的目标文件名。
- `overwrite: true` 替换同名文本或二进制文件。需要校验文本版本的编辑请使用 `write_file`。

返回结果包含保存路径、哈希和校验状态。Overleaf 可能会规范化文本编码或换行符。重试前请检查 `uploaded` 和 `verified`；返回路径会标明已保存的文件，包括等待最终重命名的临时上传文件。ZIP 上传后会作为项目附件保存。

### 编译和下载

调用 `compile_project`，指定项目 ID 和编译模式：

| 模式 | 行为 |
|---|---|
| `remote` | 使用 Overleaf 编译器 |
| `local` | 下载当前源码，使用本机 TeX 工具 |
| `auto` | 优先使用官方编译，超时或遇到符合回退条件的服务错误时转为本地编译 |

调用返回 `jobId`，随后可通过 `get_compile_result` 轮询任务状态。`state: completed` 表示任务结束，`result.status: success` 表示编译成功。LaTeX 错误会随编译日志一并返回，便于修正。

PDF、日志和下载文件会作为 MCP 资源及本地文件路径返回，能否直接预览取决于客户端。源码 ZIP 与编译 PDF 分别下载。任务 ID 只在当前服务进程中有效，保存的文件会保留在磁盘上。

### 批注与修订

先调用 `read_file` 和 `get_review`。编辑文档时，将该文件最新返回的 `docId` 和 `version` 分别作为 `expectedDocId` 和 `expectedVersion`。

- 使用 `create_comment` 创建批注，传入在文件中唯一匹配的原文 `quote` 和批注内容 `content`。
- 使用 `reply_to_comment` 回复，使用 `edit_comment_message` 或 `delete_comment_message` 管理单条消息。`threadId` 来自线程条目，`messageId` 使用 `get_review` 中对应消息的 `id`。
- 使用 `resolve_comment_thread`、`reopen_comment_thread` 和 `delete_comment_thread` 管理线程，传入线程所在文件的 `path` 和 `threadId`。
- 使用 `accept_tracked_changes` 或 `reject_tracked_changes` 处理修订，并传入文件当前的文档 ID 和版本。从该文件的 `trackedChanges` 条目中选取 `id`，组成 `changeIds`。

`posted: true` 表示消息已接受，`anchored: true` 表示新批注已定位到源码。其他 Review 写入通过 `applied` 返回应用状态，通过 `verified` 返回读回校验结果。`readBackError` 描述后续读取情况。操作状态待确认时，先刷新 `get_review` 检查当前结果，再决定是否重试。

## 工具列表

<details>
<summary>全部 29 个工具</summary>

| 工具 | 用途 |
|---|---|
| `get_session_status` | 查看登录状态、检测到的续期行为和下次保活时间 |
| `list_projects` | 列出账号可访问的项目 |
| `get_project` | 获取文件树、文件夹 ID 和主文件 |
| `read_file` | 读取最新文本，可指定行范围 |
| `watch_file` | 开始监听文本文件 |
| `wait_for_file_change` | 等待版本或文档变化，最长 30 秒 |
| `unwatch_file` | 停止通过工具创建的监听 |
| `create_file` | 创建空文本文件 |
| `write_file` | 检查文档 ID 和版本后写回文本 |
| `replace_text` | 检查版本后替换唯一匹配内容 |
| `upload_file` | 上传本地文件，可选择覆盖 |
| `download_file` | 下载文本文件或二进制附件 |
| `download_project` | 下载当前或历史版本的源码 ZIP |
| `list_history` | 查询可见历史记录及分页数据 |
| `list_history_labels` | 查询可见版本标签 |
| `get_history_diff` | 比较项目版本或其中某个文件 |
| `get_collaboration` | 查询受邀成员和当前在线用户 |
| `get_review` | 查询评论、源码位置和可见修订 |
| `reply_to_comment` | 回复已有批注线程 |
| `create_comment` | 创建附加到源码的批注 |
| `edit_comment_message` | 编辑批注或回复消息 |
| `delete_comment_message` | 删除批注或回复消息 |
| `resolve_comment_thread` | 将批注线程标记为已解决 |
| `reopen_comment_thread` | 重新打开已解决的批注线程 |
| `delete_comment_thread` | 删除批注线程及其源码标注 |
| `accept_tracked_changes` | 接受选中的修订 |
| `reject_tracked_changes` | 拒绝选中的修订 |
| `compile_project` | 启动官方、本地或自动编译任务 |
| `get_compile_result` | 获取任务状态及产物 |

</details>

比较或下载历史项目时，请使用历史工具返回的项目历史版本号。文件的 `version` 标识当前文本修订版，用于源码和 Review 编辑。

`get_collaboration` 返回受邀成员和在线用户。通过共享链接访问的协作者在连接期间会显示在在线用户列表中。`get_review` 中，`path` 用于选择查看源码批注和修订的文件，`threads` 包含项目范围内的全部可见批注线程。

## 配置和本地数据

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` | 要连接的 Overleaf 实例 |
| `OVERLEAF_STATE_DIR` | 用户主目录中的 `~/.overleaf-mcp` | 保存会话、下载文件和本地构建文件 |
| `OVERLEAF_BROWSER_CHANNEL` | `chrome` | 传给 Playwright 的浏览器 channel |

请为每个账号或 Overleaf 实例使用独立的会话目录。

早期版本将会话保存在仓库内的 `.overleaf-mcp` 目录中。要复用该会话，请在终端和 MCP 客户端配置中将 `OVERLEAF_STATE_DIR` 设为该目录的绝对路径。

会话目录包含登录 Cookie 和项目文件，请限制访问并将其排除在版本控制之外。在 POSIX 系统中，目录权限为 `0700`，会话文件权限为 `0600`。会话文件以明文 JSON 保存可复用的登录 Cookie。

当请求延长会话有效期时，运行中的服务会按最长 6 小时的间隔安排保活请求。请保持服务运行以维持保活；若会话失效，重新登录即可。

## 运行说明

- 实时读取返回与 Overleaf 同步的文本。监听报告最新快照和版本，多次快速编辑可能合并为一条通知。
- 旧版源码与批注操作支持包含中文在内的 BMP Unicode 字符；`history-ot` 协议还支持补充平面 Unicode 字符。
- 本地编译由 `latexmk` 调用 pdfLaTeX、XeLaTeX 或 LuaLaTeX，`latexmk` 命令使用 `-norc` 和 `-no-shell-escape` 参数。macOS 在可用时启用 `sandbox-exec`，其他系统作为本地进程运行编译器。请选择可信项目进行本地编译。
- 上传遵循服务端公布的大小限制，默认为 50 MiB。请将目标文件名保持在 149 个字符以内。
- 下载和解压后的 ZIP 上限为 512 MiB 及 10,000 个归档条目。下载内容在内存中缓冲。MCP 最多内嵌 32 MiB 的资源，更大的文件请使用本地路径。
- 主要验证环境为 macOS 与官方 Overleaf 服务。

## 开发

```sh
npm run check
npm test
npm run build
```

本地测试可离线运行。`scripts/` 中的在线检查使用已保存的会话。运行 `node scripts/smoke.mjs PROJECT_ID main.tex` 可执行只读检查。

写入验收脚本 `scripts/features-smoke.mjs` 和 `scripts/upload-smoke.mjs` 需要一个新建的、可用于测试的项目，名称为 `TestForMCP`。功能验收还要求项目包含可编译的 `main.tex`、JPEG 图片 `frog.jpg`、可访问的初始历史，以及一条关联到 `main.tex` 的评论。这些脚本会创建临时项目数据，并在结束时清理；中断的测试可能需要手动清理。

报告问题时，请提供工具名称、操作系统、Node 版本和脱敏后的错误摘要，并移除报告中的 Cookie、会话文件、共享令牌和私有项目内容。

## 许可证

[MIT](LICENSE)。
