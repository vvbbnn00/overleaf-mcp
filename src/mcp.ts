import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { OverleafClient } from './client.js';
import { AuthenticationError } from './session.js';
import { readArtifact } from './artifacts.js';
import { compileProject } from './compile.js';
import { randomUUID } from 'node:crypto';
import { safeErrorMessage } from './errors.js';

const projectId = z.string().regex(/^[a-f\d]{24}$/i);
const fileInput = { projectId, path: z.string().min(1) };
const uriFor = (id: string, path: string) => `overleaf://projects/${id}/files/${encodeURIComponent(path)}`;
function parseUri(value: string) {
  const url = new URL(value);
  const match = /^\/([a-f\d]{24})\/files\/(.+)$/i.exec(url.pathname);
  if (url.protocol !== 'overleaf:' || url.hostname !== 'projects' || !match) throw new Error('Invalid Overleaf resource URI');
  return { projectId: match[1], path: decodeURIComponent(match[2]) };
}

export function createMcpServer(connect = () => OverleafClient.connect()) {
  const server = new McpServer({ name: 'overleaf-mcp', version: '0.1.0' }, { capabilities: { resources: { subscribe: true } } });
  let pending: Promise<OverleafClient> | undefined;
  const subscriptions = new Set<string>();
  const toolWatches = new Set<string>();
  const waiters = new Map<string, number>();
  const shutdown = new AbortController();
  let closing = false;
  const compileJobs = new Map<string, any>();
  const getClient = () => {
    if (closing) return Promise.reject(new Error('MCP server is closed'));
    return pending ??= connect().then(async client => {
      if (closing) { await client.close(); throw new Error('MCP server is closed'); }
      client.on('change', event => {
        const uri = uriFor(event.projectId, event.path);
        if (subscriptions.has(uri)) void server.server.sendResourceUpdated({ uri }).catch(() => {});
      });
      for (const uri of new Set([...subscriptions, ...toolWatches])) {
        const { projectId, path } = parseUri(uri);
        await client.watchFile(projectId, path);
      }
      return client;
    }).catch(error => { pending = undefined; throw error; });
  };
  const resetClient = async (connection: Promise<OverleafClient>) => {
    if (pending !== connection) return;
    pending = undefined;
    await (await connection.catch(() => undefined))?.close();
  };
  const releaseWatch = (client: OverleafClient, uri: string) => {
    if (!subscriptions.has(uri) && !toolWatches.has(uri) && !waiters.get(uri)) {
      const { projectId, path } = parseUri(uri);
      client.unwatchFile(`${projectId}:${path}`);
    }
  };
  const respond = (value: any) => {
    const links = new Map<string, any>();
    const visit = (item: any) => {
      if (!item || typeof item !== 'object') return;
      if (typeof item.resourceUri === 'string' && item.resourceUri.startsWith('overleaf-artifact:')) links.set(item.resourceUri, { type: 'resource_link', uri: item.resourceUri, name: item.filename, mimeType: item.mimeType });
      for (const child of Object.values(item)) visit(child);
    };
    visit(value);
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }, ...links.values()], structuredContent: value };
  };
  const result = async (run: (client: OverleafClient) => Promise<any>) => {
    const connection = getClient();
    let connected = false;
    try {
      const client = await connection;
      connected = true;
      const value = await run(client);
      return respond(value);
    } catch (error: any) {
      if (error instanceof AuthenticationError) await resetClient(connection);
      return { isError: true, content: [{ type: 'text' as const, text: !connected && error.code === 'ENOENT' ? 'No saved session. Run overleaf-mcp login (or npm run login from the source checkout).' : safeErrorMessage(error) }] };
    }
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  server.registerTool('get_session_status', { description: 'Check the saved browser session, observed cookie renewal and keepalive schedule. Never returns cookie values.', annotations }, async () => {
    const connection = getClient();
    try {
      const status = await (await connection).checkSession();
      if (status.authenticated === false) await resetClient(connection);
      return respond(status);
    } catch (error: any) {
      if (error instanceof AuthenticationError || error.code === 'ENOENT') return respond({ authenticated: false, reason: error.code === 'ENOENT' ? 'not-configured' : 'login-required', cookies: [], checkedAt: new Date().toISOString() });
      return { isError: true, content: [{ type: 'text' as const, text: safeErrorMessage(error) }] };
    }
  });
  server.registerTool('list_projects', { description: 'List projects accessible to the signed-in account, using the server response.', annotations }, () => result(c => c.listProjects()));
  server.registerTool('get_project', { description: 'Get the live project file tree and main document.', inputSchema: { projectId }, annotations }, ({ projectId }) => result(c => c.getProject(projectId)));
  server.registerTool('get_collaboration', { description: 'Read explicitly invited members and current online users separately. Link collaborators may appear only in presence, so invitedMembers is not a complete participant list. Online connections are grouped by account; unavailable presence is reported as unknown.', inputSchema: { projectId }, annotations }, ({ projectId }) => result(c => c.getCollaboration(projectId)));
  server.registerTool('get_review', { description: 'Read project-wide comments, replies and resolution status, plus file/line anchors and visible tracked changes. path limits the annotation scan to one text file; threads remain project-wide. Data is limited by server permissions.', inputSchema: { projectId, path: z.string().optional() }, annotations }, ({ projectId, path }) => result(c => c.getReview(projectId, path)));
  const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  server.registerTool('reply_to_comment', {
    description: 'Post a reply to an existing review comment thread as the signed-in user. Use a threadId from get_review. Returns posted:true once Overleaf accepts the reply, plus the refreshed thread when available. readBackError does not mean the reply failed. On REPLY_STATUS_UNKNOWN, check get_review before retrying to avoid duplicate replies.',
    inputSchema: { projectId, threadId: z.string().regex(/^[a-f\d]{24}$/i), content: z.string().min(1) },
    annotations: { ...writeAnnotations, destructiveHint: false },
  }, ({ projectId, threadId, content }) => result(c => c.replyToComment(projectId, threadId, content)));
  const versionInput = { ...fileInput, expectedDocId: z.string().regex(/^[a-f\d]{24}$/i), expectedVersion: z.number().int().nonnegative() };
  server.registerTool('write_file', { description: 'Replace text using OT edits that retain unchanged regions. Requires docId/version from a recent read. Rejects stale versions; waits for server application and verifies document identity and content. An unknown write outcome blocks further writes to that document on the connection; reconnect and inspect before retrying. Concurrent edits may be merged by Overleaf.', inputSchema: { ...versionInput, content: z.string() }, annotations: writeAnnotations }, ({ projectId, path, expectedDocId, expectedVersion, content }) => result(c => c.writeFile(projectId, path, expectedDocId, expectedVersion, { content })));
  server.registerTool('replace_text', { description: 'Replace exactly one occurrence of oldText in a file, preserving surrounding content. Requires a recent document ID and version. Reports confirmed application separately from final-content verification.', inputSchema: { ...versionInput, oldText: z.string().min(1), newText: z.string() }, annotations: writeAnnotations }, ({ projectId, path, expectedDocId, expectedVersion, oldText, newText }) => result(c => c.writeFile(projectId, path, expectedDocId, expectedVersion, { oldText, newText })));
  server.registerTool('create_file', { description: 'Create an empty editable text file. name is a filename, not a path. Omit parentFolderId for the project root. Then use write_file to populate it.', inputSchema: { projectId, name: z.string().min(1), parentFolderId: z.string().regex(/^[a-f\d]{24}$/i).optional() }, annotations: { ...writeAnnotations, destructiveHint: false } }, ({ projectId, name, parentFolderId }) => result(c => c.createFile(projectId, name, parentFolderId)));
  server.registerTool('upload_file', {
    description: 'Upload one local file to an existing project folder. localPath must be absolute on the MCP server. path is the project-relative destination, defaulting to the local basename. overwrite defaults to false; true explicitly permits replacing a same-name text document or binary file. Returns server acceptance, actual location and content verification separately. An unverified or unknown result must be inspected before retrying. ZIPs are uploaded as files, not imported as projects.',
    inputSchema: { projectId, localPath: z.string().min(1), path: z.string().min(1).optional(), overwrite: z.boolean().default(false) }, annotations: writeAnnotations,
  }, ({ projectId, localPath, path, overwrite }) => result(c => c.uploadFile(projectId, localPath, path, overwrite)));
  server.registerTool('download_file', { description: 'Download a text file or binary attachment as a local artifact. Text documents come from a fresh live snapshot.', inputSchema: fileInput, annotations }, ({ projectId, path }) => result(c => c.downloadFile(projectId, path)));
  server.registerTool('download_project', { description: 'Download the complete current source ZIP, or an API-accessible historical project version. historyVersion is a project-history version, not a document OT version.', inputSchema: { projectId, historyVersion: z.number().int().nonnegative().optional() }, annotations }, ({ projectId, historyVersion }) => result(c => c.downloadProject(projectId, historyVersion)));
  server.registerTool('list_history_labels', { description: 'Return project version labels visible to the current session, without local plan restrictions.', inputSchema: { projectId }, annotations }, ({ projectId }) => result(c => c.historyLabels(projectId)));
  server.registerTool('get_history_diff', { description: 'Compare two project-history versions. With path, returns file content differences; without path, returns file-tree differences. Use versions returned by list_history.', inputSchema: { projectId, from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), path: z.string().optional() }, annotations }, ({ projectId, from, to, path }) => result(c => c.historyDiff(projectId, from, to, path)));
  server.registerTool('compile_project', {
    description: 'Start compilation and return a job ID immediately. mode=auto tries Overleaf first and falls back locally for timeout/service errors. Local compilation needs latexmk and the selected engine. Poll get_compile_result for this build PDF and logs.',
    inputSchema: { projectId, mode: z.enum(['auto', 'remote', 'local']).default('auto'), rootPath: z.string().optional(), compiler: z.enum(['pdflatex', 'xelatex', 'lualatex']).optional(), timeoutSeconds: z.number().int().min(1).max(600).default(120) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, options => result(async c => {
    for (const job of compileJobs.values()) if (job.projectId === options.projectId && job.state === 'running') {
      if (JSON.stringify(job.request) !== JSON.stringify(options)) throw new Error('A different compile is already running for this project; wait for that job to finish');
      return { jobId: job.jobId, state: job.state, reused: true };
    }
    const jobId = randomUUID();
    const job = { jobId, projectId: options.projectId, request: options, state: 'running', startedAt: new Date().toISOString() } as any;
    compileJobs.set(jobId, job);
    void compileProject(c, { ...options, signal: shutdown.signal }).then(value => Object.assign(job, { state: 'completed', result: value }), error => Object.assign(job, { state: 'failed', error: safeErrorMessage(error) })).finally(() => { job.finishedAt = new Date().toISOString(); });
    return { jobId, state: job.state };
  }));
  server.registerTool('get_compile_result', { description: 'Get compilation job state, PDF/log artifact URIs and the actual compile status. state=completed means the job finished; result.status determines whether compilation succeeded.', inputSchema: { jobId: z.string().uuid() }, annotations }, async ({ jobId }) => {
    const job = compileJobs.get(jobId);
    return job ? respond(job) : { isError: true, content: [{ type: 'text' as const, text: 'Unknown job ID (jobs belong to this server process)' }] };
  });
  server.registerTool('read_file', {
    description: 'Read a text file directly from the live document server. Each call obtains a fresh snapshot and version, not a ZIP or disk cache. Optional 1-based line range.',
    inputSchema: { ...fileInput, startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }, annotations,
  }, ({ projectId, path, startLine, endLine }) => result(async c => ({ ...await c.readFile(projectId, path, startLine, endLine), resourceUri: uriFor(projectId, path) })));
  server.registerTool('watch_file', { description: 'Start watching server-pushed document changes. Use wait_for_file_change or subscribe to the returned resource URI.', inputSchema: fileInput, annotations }, ({ projectId, path }) => result(async c => {
    const uri = uriFor(projectId, path);
    toolWatches.add(uri);
    return { ...await c.watchFile(projectId, path), resourceUri: uri };
  }));
  server.registerTool('wait_for_file_change', {
    description: 'Wait for a document version to change, up to 30 seconds. Returns the new content, or changed:false on timeout. Disconnections are reported explicitly.',
    inputSchema: { ...fileInput, afterVersion: z.number().int(), afterDocId: z.string().optional().describe('Document ID from the previous read; detects replacement of the file at the same path.'), timeoutSeconds: z.number().min(1).max(30).default(25) }, annotations,
  }, ({ projectId, path, afterVersion, afterDocId, timeoutSeconds }, extra) => result(async c => {
    const uri = uriFor(projectId, path);
    waiters.set(uri, (waiters.get(uri) ?? 0) + 1);
    const signal = AbortSignal.any([extra.signal, shutdown.signal]);
    let watchedDocId = afterDocId;
    try { return await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); c.off('change', listener); c.off('closed', onClose); signal.removeEventListener('abort', onAbort);
      };
      const finish = (value: unknown) => { cleanup(); resolve(value); };
      const fail = (error: unknown) => { cleanup(); reject(error); };
      const listener = (event: any) => {
        if (event.projectId === projectId && event.path === path && (!event.live || event.version !== afterVersion || (watchedDocId && event.docId !== watchedDocId))) {
          finish({ changed: event.live === true, ...event });
        }
      };
      const onAbort = () => fail(new Error('Wait canceled'));
      const onClose = () => fail(new Error('Overleaf connection closed'));
      const timer = setTimeout(() => finish({ changed: false, version: afterVersion, projectId, path }), timeoutSeconds * 1000);
      c.on('change', listener);
      c.on('closed', onClose);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      void c.watchFile(projectId, path).then(current => {
        if (!current.live || current.version !== afterVersion || (watchedDocId && current.docId !== watchedDocId)) finish({ changed: current.live === true, ...current });
        watchedDocId ??= current.docId;
      }, fail);
    }); } finally {
      const count = (waiters.get(uri) ?? 1) - 1;
      if (count) waiters.set(uri, count); else waiters.delete(uri);
      releaseWatch(c, uri);
    }
  }));
  server.registerTool('unwatch_file', { description: 'Stop a watch created by watch_file. Independent resource subscriptions and pending waits remain active.', inputSchema: { watchId: z.string().regex(/^[a-f\d]{24}:.+/i) }, annotations }, ({ watchId }) => result(async c => {
    const uri = uriFor(watchId.slice(0, 24), watchId.slice(25));
    const removed = toolWatches.delete(uri);
    releaseWatch(c, uri);
    return { removed };
  }));
  server.registerTool('list_history', {
    description: 'Return the history API response unchanged. No local time-window restriction or subscription filtering is applied. Pass the server pagination cursor as before.',
    inputSchema: { projectId, before: z.string().optional() }, annotations,
  }, ({ projectId, before }) => result(c => c.history(projectId, before)));
  server.registerResource('live_file', new ResourceTemplate('overleaf://projects/{projectId}/files/{path}', { list: undefined }), { description: 'Latest server-confirmed text file content', mimeType: 'text/plain' }, async uri => {
    const { projectId, path } = parseUri(uri.href);
    const connection = getClient();
    try {
      const value = await (await connection).readFile(projectId, path);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: value.content }] };
    } catch (error) {
      if (error instanceof AuthenticationError) await resetClient(connection);
      throw new Error(safeErrorMessage(error));
    }
  });
  server.registerResource('artifact', new ResourceTemplate('overleaf-artifact:///{artifactId}/{filename}', { list: undefined }), { description: 'Downloaded source, attachment or compilation output; large artifacts remain available at their localPath.' }, async uri => {
    try {
      const { info, bytes } = await readArtifact(uri.href);
      return { contents: [info.mimeType.startsWith('text/') ? { uri: uri.href, mimeType: info.mimeType, text: bytes.toString('utf8') } : { uri: uri.href, mimeType: info.mimeType, blob: bytes.toString('base64') }] };
    } catch (error) { throw new Error(safeErrorMessage(error)); }
  });
  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    const { projectId, path } = parseUri(params.uri);
    const uri = uriFor(projectId, path);
    let c: OverleafClient | undefined;
    try {
      c = await getClient();
      subscriptions.add(uri);
      const state = await c.watchFile(projectId, path);
      if (!state.live) throw new Error(state.error ?? 'File is unavailable');
    } catch (error) {
      subscriptions.delete(uri);
      if (c) releaseWatch(c, uri);
      throw new Error(safeErrorMessage(error));
    }
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    const { projectId, path } = parseUri(params.uri);
    const uri = uriFor(projectId, path);
    subscriptions.delete(uri);
    try { if (pending) releaseWatch(await pending, uri); }
    catch (error) { throw new Error(safeErrorMessage(error)); }
    return {};
  });
  const close = async () => {
    if (closing) return;
    closing = true;
    shutdown.abort();
    if (pending) await (await pending.catch(() => undefined))?.close();
    await server.close();
  };
  server.server.onclose = () => void close();
  return { server, close };
}

export async function serve() {
  const { server, close } = createMcpServer();
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await server.connect(new StdioServerTransport());
}
