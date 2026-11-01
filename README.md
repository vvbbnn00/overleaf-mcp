# Overleaf MCP

English | [简体中文](README.zh-CN.md)

Connect an MCP-compatible assistant to your [Overleaf](https://www.overleaf.com/) projects. Read live LaTeX files, edit source, upload attachments, inspect comments and history, and compile PDFs.

This is an **unofficial, experimental integration**. It runs locally over stdio and uses Overleaf's web endpoints and realtime connection. Changes to Overleaf may require updates here.

## Features

| Area | Supported features |
|---|---|
| Projects | List accessible projects; browse files, folders and main-document settings |
| Live reading | Read a whole text file or selected lines; watch changes and receive MCP resource notifications |
| Editing | Create text files, replace exact text or write back a file with document ID and version checks |
| Uploads | Upload local text, images, PDFs and other files; optionally overwrite existing files |
| Downloads | Download individual files, complete source ZIPs and accessible historical versions |
| History | Read change records, labels, file-tree differences and text differences |
| Collaboration and review | Read invited members, online users, comments, replies, resolution status, source positions and visible tracked changes |
| Compilation | Compile on Overleaf or locally; retrieve the PDF and logs; fall back locally after remote timeouts or service errors |

You can use a free Overleaf account. Account permissions, project permissions and plan limits still apply, including limits on history, tracked changes and compilation. The server does not impose an additional history time window.

## Quick start

You need:

- Node.js **22 or newer**, npm and Git.
- Google Chrome installed locally.
- An Overleaf account with access to the projects you want to use.
- For local compilation only: `latexmk` and the selected TeX engine. MacTeX or TeX Live can provide them.

### Run directly from GitHub

Use `npx` to download, build and run the server without a manual clone:

```sh
npx --yes git+https://github.com/vvbbnn00/overleaf-mcp.git login
```

The Git install needs npm to run the package's build script. This path has been tested with npm 10. If your npm version or policy blocks dependency build scripts, use the source installation below.

Sign in manually in the browser window and complete any verification steps. The program does not read or submit your password. Once you sign in, the browser closes and the command exits automatically. Your saved session is now ready for your MCP client.

Check the saved session:

```sh
npx --yes git+https://github.com/vvbbnn00/overleaf-mcp.git status
```

### Connect your MCP client

For clients that use a `mcpServers` configuration, add:

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

Login and the server share `~/.overleaf-mcp` by default, regardless of the working directory. If your client cannot find `npx`, use its full path and make sure Node is on the client's `PATH`. Other clients may use a different configuration format.

Your MCP client starts the server. It communicates over stdio; there is no HTTP port or web dashboard to open.

### Install from source

For development or a fixed local installation:

```sh
git clone https://github.com/vvbbnn00/overleaf-mcp.git
cd overleaf-mcp
npm ci
npm run build
npm run login
```

For this installation, set the MCP command to `node` and its arguments to `["/absolute/path/to/overleaf-mcp/dist/cli.js", "serve"]`, using your checkout's actual path. Check the session with `npm run dev -- status`.

## Using it

Start with `list_projects` to get a project ID, then `get_project` to see its files and folders. You can ask your assistant to:

- Read `main.tex` and explain a section.
- Replace a specific paragraph while preserving the surrounding text.
- Upload a figure into an existing project folder.
- Show unresolved comments and their source locations.
- Compile the project and open the resulting PDF.

### Edit source

Read the file first. Pass its returned `docId` and `version` as `expectedDocId` and `expectedVersion` to `write_file` or `replace_text`.

`replace_text` requires a single exact match for `oldText`. `write_file` accepts the full target text and submits edits that retain unchanged regions. Overleaf may merge edits made concurrently by collaborators.

The result separates three checks:

| Field | Meaning |
|---|---|
| `applied` | Overleaf confirmed that it applied the edit |
| `verified` | A subsequent read found the same document at or beyond the confirmed version |
| `matchesRequestedContent` | The resulting text matches what you requested |

On `VERSION_CONFLICT`, read the file again. On `WRITE_STATUS_UNKNOWN`, reconnect the MCP server and inspect the document before deciding whether to retry. After this error, that connection rejects further writes to the document.

### Upload files

Example arguments for `upload_file`:

```json
{
  "projectId": "PROJECT_ID",
  "localPath": "/absolute/path/to/figure.png",
  "path": "figures/figure.png",
  "overwrite": false
}
```

Replace `PROJECT_ID` and the file paths with your values. `localPath` refers to a file on the machine running this server. The destination folder must already exist. Omit `path` to use the local filename in the project root.

- `overwrite: false` is the default and rejects same-name files.
- `overwrite: true` permits replacing a same-name text document or binary file. It does not check a document version.

The response includes the actual saved path, hashes, and verification status. Overleaf may normalize the encoding or line endings of uploaded text files. If `uploaded` is true but `verified` is false, inspect the result before retrying. If the final rename fails, a temporary file may remain at the returned path. ZIP uploads are stored as files, not imported as new projects.

### Compile and download

Call `compile_project` with a project ID and a mode:

| Mode | Behavior |
|---|---|
| `remote` | Use Overleaf's compiler |
| `local` | Download the current source and use local TeX tools |
| `auto` | Try Overleaf first; use local compilation after a timeout or eligible service error |

The call returns a `jobId`. Poll `get_compile_result` until the job finishes. `state: completed` means the job ended; `result.status: success` means compilation succeeded. Source errors do not trigger an automatic local retry.

PDFs, logs and downloads are returned as MCP resources and local file paths. Preview support depends on your MCP client. Source ZIPs and compiled PDFs are separate downloads. Job IDs last for the current server process; saved files remain on disk.

## Tool reference

<details>
<summary>All 20 tools</summary>

| Tool | Purpose |
|---|---|
| `get_session_status` | Check login, observed session renewal and the next keepalive |
| `list_projects` | List projects accessible to the account |
| `get_project` | Get the file tree, folder IDs and main document |
| `read_file` | Read current text, optionally by line range |
| `watch_file` | Start watching a text file |
| `wait_for_file_change` | Wait up to 30 seconds for a different version or document |
| `unwatch_file` | Stop a tool-created watch |
| `create_file` | Create an empty text file |
| `write_file` | Write text with document ID and version checks |
| `replace_text` | Replace one exact occurrence with version checks |
| `upload_file` | Upload a local file with optional overwrite |
| `download_file` | Download a text file or binary attachment |
| `download_project` | Download a current or historical source ZIP |
| `list_history` | Read available history records and pagination data |
| `list_history_labels` | Read available version labels |
| `get_history_diff` | Compare project versions or a file within them |
| `get_collaboration` | Read invited members and current online users |
| `get_review` | Read comments, source positions and visible tracked changes |
| `compile_project` | Start a remote, local or automatic compile job |
| `get_compile_result` | Get a job's status and output files |

</details>

History version numbers differ from a text file's `version`. Use versions returned by the history tools when comparing or downloading old project versions.

`get_collaboration` returns invited members and online users separately. Neither list is a complete inventory of everyone who can access a shared link. In `get_review`, `path` limits the annotation scan; `threads` remains the project-wide comment collection.

## Configuration and local data

| Environment variable | Default | Purpose |
|---|---|---|
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` | Overleaf instance to connect to |
| `OVERLEAF_STATE_DIR` | `~/.overleaf-mcp` in your home directory | Session, downloads and local build files |
| `OVERLEAF_BROWSER_CHANNEL` | `chrome` | Browser channel passed to Playwright |

Use separate state directories for different accounts or instances. Self-hosted compatibility is not yet validated.

Earlier checkouts saved sessions in the repository's `.overleaf-mcp` directory. To reuse one, set `OVERLEAF_STATE_DIR` to that directory's absolute path in both your shell and MCP client configuration. Existing sessions are not moved automatically.

The state directory contains login cookies and project files. Keep it private and out of version control. On POSIX systems, the directory uses mode `0700` and the session file uses `0600`. Cookies are stored locally without application-level encryption.

If requests demonstrably extend the session's expiry, the running server schedules keepalive requests at an interval of up to 6 hours. This cannot restore a revoked session or keep it alive while the process is stopped.

## Current limits

- Live reads show content received by Overleaf's server. They cannot see browser edits that have not synchronized yet. Watches may coalesce intermediate changes.
- The legacy document protocol corrupts newly inserted non-BMP characters, including many emoji. The server rejects these edits before submission. Chinese text has been tested.
- Local compilation requires `latexmk` and pdfLaTeX, XeLaTeX or LuaLaTeX. Project `latexmkrc` files and shell escape are disabled. macOS uses an additional sandbox when available; other systems do not get equivalent OS-level isolation. Use trusted projects for local compilation.
- Uploads follow the advertised server size limit, or 50 MiB if none is advertised. Destination filenames must be shorter than 150 characters.
- Downloads and expanded ZIPs have a 512 MiB limit; extraction allows at most 10,000 entries. Downloads are buffered in memory. MCP resource embedding is limited to 32 MiB; larger files remain available through their local path.
- macOS and the official Overleaf service have been exercised. Other operating systems, self-hosted instances, large concurrent workloads, live `history-ot` projects and non-empty tracked-change data still need broader validation.

Project creation/deletion, folder creation, general file rename/move/delete, invitation management, and accepting or rejecting tracked changes are not exposed as MCP tools.

## Development

```sh
npm run check
npm test
npm run build
```

The local tests do not require an Overleaf login. Live checks are in `scripts/` and use a saved session. For a read-only check, run `node scripts/smoke.mjs PROJECT_ID main.tex`.

The write checks, `scripts/features-smoke.mjs` and `scripts/upload-smoke.mjs`, require a fresh disposable project named `TestForMCP`. The feature check expects a compilable `main.tex`, a JPEG named `frog.jpg`, accessible initial history, and a comment attached to `main.tex`. These scripts create temporary project data and remove it when they finish; interrupted runs may need manual cleanup.

When reporting a problem, include the tool name, operating system, Node version and a redacted error summary. Do not include cookies, session files, sharing tokens or private project content.

## License

[MIT](LICENSE).
