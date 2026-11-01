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
| Collaboration | Read invited members and online users |
| Review | Read and create comments; reply, edit and delete messages; resolve, reopen and delete threads; accept and reject tracked changes |
| Compilation | Compile on Overleaf or locally; retrieve the PDF and logs; fall back locally after remote timeouts or service errors |

Use a free Overleaf account with access to your projects. Available history, review actions and compilation follow the account and project permissions returned by Overleaf.

## Quick start

You need:

- Node.js **22 or newer**, npm and Git.
- Google Chrome installed locally.
- An Overleaf account with access to the projects you want to use.
- For local compilation only: `latexmk` and the selected TeX engine. MacTeX or TeX Live can provide them.

### Run directly from GitHub

Use `npx` to download, build and run the server:

```sh
npx --yes git+https://github.com/vvbbnn00/overleaf-mcp.git login
```

Git installation runs the package build script through npm and is tested with npm 10. Source installation provides direct control over dependency installation and building.

Sign in manually in the browser and complete any verification steps. After sign-in, the session is saved, the browser closes and the command exits. Your MCP client can then use the saved session.

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

Login and the server share `~/.overleaf-mcp` by default. Make `npx` and Node available on the MCP client's `PATH`, or configure the full path to `npx`. Use your client's configuration format.

Your MCP client starts the server and communicates with it over stdio.

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
- Show open comments and their source locations.
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

- `overwrite: false` keeps existing files and requires a new destination name.
- `overwrite: true` replaces a same-name text document or binary file. Use `write_file` for text edits that require a version match.

The response includes the saved path, hashes and verification status. Overleaf may normalize text encoding or line endings. Check `uploaded` and `verified` before retrying; the returned path identifies the saved file, including a temporary upload awaiting its final rename. ZIP uploads are saved as project attachments.

### Compile and download

Call `compile_project` with a project ID and a mode:

| Mode | Behavior |
|---|---|
| `remote` | Use Overleaf's compiler |
| `local` | Download the current source and use local TeX tools |
| `auto` | Try Overleaf first; use local compilation after a timeout or eligible service error |

The call returns a `jobId`. Poll `get_compile_result` until the job finishes. `state: completed` marks the end of the job; `result.status: success` confirms successful compilation. LaTeX errors are returned with compiler logs for correction.

PDFs, logs and downloads are returned as MCP resources and local file paths. Preview support depends on your MCP client. Source ZIPs and compiled PDFs are separate downloads. Job IDs last for the current server process; saved files remain on disk.

### Comments and tracked changes

Start with `read_file` and `get_review`. For document edits, copy `docId` to `expectedDocId` and `version` to `expectedVersion` from the latest result for that file.

- Use `create_comment` with a `quote` that appears once in the file and your comment `content`.
- Use `reply_to_comment` to reply. Use `edit_comment_message` or `delete_comment_message` to manage individual messages. Get `threadId` from the thread entry and `messageId` from the message's `id` in `get_review`.
- Use `resolve_comment_thread`, `reopen_comment_thread` and `delete_comment_thread` with the thread's `path` and `threadId`.
- Use `accept_tracked_changes` or `reject_tracked_changes` with the file's current document ID and version. Select `id` values from its `trackedChanges` entries and pass them as `changeIds`.

`posted: true` confirms message acceptance; `anchored: true` confirms source placement for a new comment. Other review writes report `applied`, followed by a readback result in `verified`. `readBackError` describes the follow-up read. Refresh `get_review` to inspect the current result and decide whether to retry.

## Tool reference

<details>
<summary>All 29 tools</summary>

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
| `reply_to_comment` | Reply to an existing review comment thread |
| `create_comment` | Create a comment attached to source text |
| `edit_comment_message` | Edit a comment or reply message |
| `delete_comment_message` | Delete a comment or reply message |
| `resolve_comment_thread` | Mark a comment thread as resolved |
| `reopen_comment_thread` | Reopen a resolved comment thread |
| `delete_comment_thread` | Delete a comment thread and its source annotation |
| `accept_tracked_changes` | Accept selected tracked changes |
| `reject_tracked_changes` | Reject selected tracked changes |
| `compile_project` | Start a remote, local or automatic compile job |
| `get_compile_result` | Get a job's status and output files |

</details>

Use project-history versions from the history tools to compare or download historical projects. A file's `version` identifies its current text revision for source and review edits.

`get_collaboration` returns invited members and online users. Collaborators using shared links appear among online users while connected. In `get_review`, `path` selects the file for source annotations and tracked changes; `threads` contains the project-wide comment threads.

## Configuration and local data

| Environment variable | Default | Purpose |
|---|---|---|
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` | Overleaf instance to connect to |
| `OVERLEAF_STATE_DIR` | `~/.overleaf-mcp` in your home directory | Session, downloads and local build files |
| `OVERLEAF_BROWSER_CHANNEL` | `chrome` | Browser channel passed to Playwright |

Use a separate state directory for each account or Overleaf instance.

Earlier checkouts saved sessions in the repository's `.overleaf-mcp` directory. To reuse that session, set `OVERLEAF_STATE_DIR` to the directory's absolute path in both your shell and MCP client configuration.

The state directory contains session cookies and project files. Keep access private and exclude the directory from version control. On POSIX systems, the directory uses mode `0700` and the session file uses `0600`. The session file stores reusable login cookies as plain JSON.

When requests extend the session expiry, the running server schedules keepalive requests at intervals of up to 6 hours. Keep the server running for keepalive, and sign in again when the session is revoked.

## Runtime behavior

- Live reads return text synchronized to Overleaf. Watches report the latest snapshot and version; several rapid edits may arrive in one notification.
- Legacy source and annotation operations support BMP Unicode, including Chinese. The `history-ot` protocol also supports supplementary Unicode characters.
- Local compilation uses `latexmk` to run pdfLaTeX, XeLaTeX or LuaLaTeX. The `latexmk` command uses `-norc` and `-no-shell-escape`. macOS adds `sandbox-exec` when available; other systems run the compiler as a local process. Choose trusted projects for local compilation.
- Uploads use the advertised server size limit, with a default of 50 MiB. Keep destination filenames under 150 characters.
- Downloads and expanded ZIPs allow up to 512 MiB and 10,000 archive entries. Downloads buffer in memory. MCP embeds resources up to 32 MiB; use the local path for larger files.
- The primary validation environment is macOS with the official Overleaf service.

## Development

```sh
npm run check
npm test
npm run build
```

Local tests run offline. Live checks in `scripts/` use a saved session. Run `node scripts/smoke.mjs PROJECT_ID main.tex` for a read-only check.

The write checks, `scripts/features-smoke.mjs` and `scripts/upload-smoke.mjs`, require a fresh disposable project named `TestForMCP`. The feature check expects a compilable `main.tex`, a JPEG named `frog.jpg`, accessible initial history, and a comment attached to `main.tex`. These scripts create temporary project data and remove it when they finish; interrupted runs may need manual cleanup.

When reporting a problem, include the tool name, operating system, Node version and a redacted error summary. Remove cookies, session files, sharing tokens and private project content from the report.

## License

[MIT](LICENSE).
