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
| 协作与 Review | 查看受邀成员、在线用户、评论、回复、解决状态、源码位置和可见修订 |
| 编译 | 使用官方或本地编译器，获取 PDF 和日志，在官方超时或服务故障时回退到本地 |

可以使用免费的 Overleaf 账号。账号权限、项目权限和套餐限制仍然生效，包括历史、修订和编译限制。本服务不额外设置历史记录的可见时间范围。

## 快速开始

需要准备：

- Node.js **22 或更新版本**以及 npm。
- 本机已安装 Google Chrome。
- 一个有权访问目标项目的 Overleaf 账号。
- 仅本地编译需要：`latexmk` 和对应 TeX 引擎，可由 MacTeX 或 TeX Live 提供。

在仓库目录中运行：

```sh
npm ci
npm run build
npm run login
```

在打开的浏览器窗口中手动登录，并完成必要的验证。程序不会读取或提交密码。终端显示 `Login confirmed` 后，可以按 `Ctrl+C` 结束登录命令，保存的会话仍可继续使用。

检查已保存的会话：

```sh
npm run dev -- status
```

### 接入 MCP 客户端

对于使用 `mcpServers` 配置格式的客户端，可以添加：

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/overleaf-mcp/dist/cli.js", "serve"],
      "env": {
        "OVERLEAF_STATE_DIR": "/absolute/path/to/overleaf-mcp/.overleaf-mcp"
      }
    }
  }
}
```

将两处仓库路径替换为实际位置。会话目录必须与登录时使用的目录一致。如果客户端找不到 `node`，请填写 Node 可执行文件的完整路径。其他客户端的配置格式可能不同。

MCP 客户端会启动服务，并通过 stdio 与它通信，不需要打开 HTTP 端口或网页控制台。

## 使用方式

先用 `list_projects` 获取项目 ID，再用 `get_project` 查看文件和文件夹。你可以让助手：

- 读取 `main.tex` 并解释其中一节。
- 替换指定段落，保留周围内容。
- 将图片上传到项目中已有的文件夹。
- 查看未解决评论及其源码位置。
- 编译项目并打开生成的 PDF。

### 修改源码

先读取文件，将返回的 `docId` 和 `version` 作为 `expectedDocId`、`expectedVersion` 传给 `write_file` 或 `replace_text`。

`replace_text` 要求 `oldText` 恰好匹配一处。`write_file` 接收期望的完整文本，并提交保留未修改片段的编辑。协作者同时进行的修改可能由 Overleaf 合并。

返回结果分别说明：

| 字段 | 含义 |
|---|---|
| `applied` | Overleaf 已确认应用修改 |
| `verified` | 随后读取的仍是原文档，且版本不早于确认版本 |
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

- `overwrite: false` 为默认值，拒绝同名文件。
- `overwrite: true` 允许覆盖同名文本或二进制文件，不检查文档版本。

返回结果包含实际保存路径、哈希和校验状态。Overleaf 可能规范化上传文本的编码或换行符。如果 `uploaded` 为真而 `verified` 为假，应先检查结果再重试。最后一步重命名失败时，临时文件可能保留在返回的路径中。ZIP 在此作为文件上传，不会导入成新项目。

### 编译和下载

调用 `compile_project`，指定项目 ID 和编译模式：

| 模式 | 行为 |
|---|---|
| `remote` | 使用 Overleaf 编译器 |
| `local` | 下载当前源码，使用本机 TeX 工具 |
| `auto` | 优先使用官方编译，超时或遇到符合回退条件的服务错误时转为本地编译 |

调用会返回 `jobId`，随后通过 `get_compile_result` 查询任务。`state: completed` 只表示任务结束，`result.status: success` 才表示编译成功。源码错误不会触发自动本地重试。

PDF、日志和下载文件会作为 MCP 资源及本地文件路径返回，能否直接预览取决于客户端。源码 ZIP 与编译 PDF 分别下载。任务 ID 只在当前服务进程中有效，保存的文件会保留在磁盘上。

## 工具列表

<details>
<summary>全部 20 个工具</summary>

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
| `compile_project` | 启动官方、本地或自动编译任务 |
| `get_compile_result` | 获取任务状态及产物 |

</details>

项目历史版本号与文本文件的 `version` 不同。比较或下载历史版本时，应使用历史工具返回的版本号。

`get_collaboration` 分别返回受邀成员和在线用户，两者都不是共享链接访问者的完整名单。`get_review` 的 `path` 只限定源码位置和修订的扫描范围，`threads` 仍为项目级评论集合。

## 配置和本地数据

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` | 要连接的 Overleaf 实例 |
| `OVERLEAF_STATE_DIR` | 工作目录中的 `.overleaf-mcp` | 保存会话、下载文件和本地构建文件 |
| `OVERLEAF_BROWSER_CHANNEL` | `chrome` | 传给 Playwright 的浏览器 channel |

不同账号或实例应使用独立的会话目录。自部署兼容性尚未验收。

会话目录包含登录 Cookie 和项目文件，应保持私有并排除在版本控制之外。POSIX 系统中，目录权限为 `0700`，会话文件权限为 `0600`。Cookie 保存在本地，没有应用层加密。

确认请求能延长会话有效期后，运行中的服务会安排保活请求，间隔最长 6 小时。保活不能恢复已撤销的会话，也不能在进程停止时继续生效。

## 当前限制

- 实时读取只能看到已到达 Overleaf 服务端的内容，不能看到浏览器尚未同步的输入。监听可能合并中间变化。
- 旧版文档协议会损坏新插入的非 BMP 字符，包括许多 emoji。本服务会在提交前拒绝这类编辑；普通中文已测试。
- 本地编译需要 `latexmk` 和 pdfLaTeX、XeLaTeX 或 LuaLaTeX。项目中的 `latexmkrc` 和 shell escape 被禁用；macOS 在可用时使用额外沙箱，其他系统没有等价的操作系统级隔离。本地编译应使用可信项目。
- 上传遵循服务端公布的大小限制；没有公布时使用 50 MiB。目标文件名需少于 150 个字符。
- 单次下载和 ZIP 解压大小上限为 512 MiB，最多解压 10,000 个条目。下载会缓冲在内存中。MCP 内嵌资源上限为 32 MiB，更大的文件可通过本地路径访问。
- 已在 macOS 和官方 Overleaf 服务上验收。其他操作系统、自部署、大规模并发、真实 `history-ot` 项目及非空修订数据仍需进一步验证。

目前没有提供项目创建或删除、文件夹创建、通用文件重命名、移动或删除、邀请管理，以及接受或拒绝修订的 MCP 工具。

## 开发

```sh
npm run check
npm test
npm run build
```

本地测试不需要登录 Overleaf。线上验收脚本位于 `scripts/`，使用已保存的会话。只读检查可运行 `node scripts/smoke.mjs PROJECT_ID main.tex`。

写入验收脚本 `scripts/features-smoke.mjs` 和 `scripts/upload-smoke.mjs` 需要一个新建的、可用于测试的项目，名称为 `TestForMCP`。功能验收还要求项目包含可编译的 `main.tex`、JPEG 图片 `frog.jpg`、可访问的初始历史，以及一条关联到 `main.tex` 的评论。这些脚本会创建临时项目数据，并在结束时清理；中断的测试可能需要手动清理。

报告问题时，请附上工具名称、操作系统、Node 版本和脱敏后的错误摘要，不要附带 Cookie、会话文件、共享令牌或私有项目内容。

## 许可证

[MIT](LICENSE)。
