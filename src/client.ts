import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, Page } from 'playwright';
import { authenticatedContext, AuthenticationError, baseUrl, probeSession, saveSession, type SessionStatus } from './session.js';
import { installLiveBridge, readLiveDocument, readLivePresence, submitDocumentEdit } from './live-bridge.js';
import { flattenFiles, flattenFolders, renewalDelay, selectLines, textEditOperation, replaceExact, type ProjectFile } from './model.js';
import { saveArtifact } from './artifacts.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { posix } from 'node:path';
import { commentOperation, documentReview, trackedChangePlan } from './review.js';
import { loadUpload, uploadDestination, uploadedTextMatches } from './uploads.js';
import { safeErrorMessage } from './errors.js';

type ProjectConnection = { page: Page; dirtyTree: boolean };
type ProjectSummary = { id: string; name: string; rootDocId?: string; compiler?: string; spellCheckLanguage?: string; files: ProjectFile[]; folders?: { id: string; path: string }[] };
type Watch = { projectId: string; docId?: string; path: string; current: any; dirty: boolean; refresh?: Promise<void> };

export class OverleafClient extends EventEmitter {
  private projects = new Map<string, Promise<ProjectConnection>>();
  private watches = new Map<string, Watch>();
  private keepalive?: NodeJS.Timeout;
  private rollingObserved = false;
  private renewalProbeScheduled = false;
  private sessionState?: SessionStatus;
  private sessionCheck?: Promise<SessionStatus>;
  private closed = false;
  private authenticationLost = false;
  private writes = new Map<string, Promise<unknown>>();

  private constructor(readonly browser: Browser, readonly context: BrowserContext, private dashboard: Page) { super(); }

  static async connect() {
    const { browser, context } = await authenticatedContext();
    try {
      const initial = await probeSession(context);
      if (initial.authenticated === false) throw new AuthenticationError('Authentication required. Run overleaf-mcp login (or npm run login from the source checkout).');
      if (initial.authenticated === null) throw new Error(`Session check unavailable (HTTP ${initial.status}); retry without logging in again.`);
      const page = await context.newPage();
      await page.route('**/*', route => route.request().resourceType() === 'script' ? route.abort() : route.continue());
      await page.goto(`${baseUrl}/project`, { waitUntil: 'domcontentloaded' });
      if (!await page.locator('meta[name="ol-user_id"]').getAttribute('content').catch(() => null)) {
        throw new AuthenticationError('Authentication required. Run overleaf-mcp login (or npm run login from the source checkout) and sign in in the browser.');
      }
      const client = new OverleafClient(browser, context, page);
      client.rollingObserved = initial.cookies.some(c => c.expiryAdvancedSeconds > 1);
      await client.checkSession();
      return client;
    } catch (error) { await browser.close(); throw error; }
  }

  checkSession(): Promise<SessionStatus> {
    if (!this.sessionCheck) this.sessionCheck = this.performSessionCheck().finally(() => { this.sessionCheck = undefined; });
    return this.sessionCheck;
  }

  private async performSessionCheck(): Promise<SessionStatus> {
    if (this.keepalive) clearTimeout(this.keepalive);
    const state = await probeSession(this.context);
    if (state.authenticated === false) {
      this.authenticationLost = true;
      for (const watch of this.watches.values()) {
        watch.current = { projectId: watch.projectId, path: watch.path, live: false, error: 'Authentication required. Run overleaf-mcp login (or npm run login from the source checkout).' };
        this.emit('change', watch.current);
      }
    }
    this.rollingObserved ||= state.authenticated === true && state.cookies.some(c => c.expiryAdvancedSeconds > 1);
    this.sessionState = { ...state, rollingExpiryObserved: this.rollingObserved };
    if (state.authenticated && this.rollingObserved && !this.closed) {
      const remaining = state.cookies.map(c => c.remainingSeconds).filter((v): v is number => v !== null && v > 0);
      if (remaining.length) {
        const delay = renewalDelay(Math.min(...remaining));
        this.sessionState.nextKeepaliveAt = new Date(Date.now() + delay).toISOString();
        this.scheduleSessionCheck(delay);
      }
    } else if (state.authenticated === null) {
      this.scheduleSessionCheck((state.retryAfterSeconds ?? 60) * 1000);
    } else if (state.authenticated && !this.renewalProbeScheduled && !this.closed) {
      // A check immediately after login can fall within the same cookie timestamp.
      // Probe once later before concluding that the instance does not roll expiry.
      this.renewalProbeScheduled = true;
      this.scheduleSessionCheck(60000);
    }
    this.emit('session', this.sessionState);
    return this.sessionState;
  }

  private scheduleSessionCheck(delay: number) {
    if (this.closed) return;
    this.keepalive = setTimeout(() => void this.checkSession().catch(() => {
      this.emit('session', { authenticated: null, error: 'Session check failed; retrying in 60 seconds' });
      this.scheduleSessionCheck(60000);
    }), delay);
    this.keepalive.unref();
  }

  async request(path: string, method = 'GET', body?: unknown, timeoutMs = 30000) {
    if (this.closed) throw new Error('Overleaf client is closed');
    if (this.authenticationLost) throw new AuthenticationError('Authentication required. Run overleaf-mcp login (or npm run login from the source checkout).');
    const result = await this.dashboard.evaluate(async ({ path, method, body, baseUrl, timeoutMs }) => {
      const csrf = document.querySelector('meta[name="ol-csrfToken"]')?.getAttribute('content') ?? '';
      const response = await fetch(baseUrl + path, {
        method, credentials: 'include', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-CSRF-Token': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const loginRequired = response.status === 401 || /\/login(?:[/?#]|$)/.test(new URL(response.url).pathname);
      const isJson = response.headers.get('content-type')?.includes('application/json');
      return { status: response.status, ok: response.ok, loginRequired, isJson, data: response.ok && isJson ? await response.json() : undefined };
    }, { path, method, body, baseUrl, timeoutMs });
    if (result.loginRequired) {
      this.authenticationLost = true;
      throw new AuthenticationError('Authentication required. Run overleaf-mcp login (or npm run login from the source checkout).');
    }
    if (!result.ok) throw Object.assign(new Error(`Overleaf returned HTTP ${result.status}`), { status: result.status });
    if (!result.isJson && result.status !== 204) throw new Error('Overleaf did not return JSON; retry or check the service status.');
    await saveSession(this.context);
    return result.data;
  }

  async listProjects() {
    const projects: any[] = [];
    const seen = new Set<string>();
    let lastId: string | undefined;
    let totalSize = 0;
    do {
      const page = await this.request('/api/project', 'POST', { filters: {}, sort: { by: 'lastUpdated', order: 'desc' }, page: { size: 100, ...(lastId ? { lastId } : {}) } });
      totalSize = page.totalSize;
      const fresh = page.projects.filter((p: any) => !seen.has(p.id));
      if (!fresh.length && projects.length < totalSize) throw new Error('Project pagination made no progress; the server did not return all projects');
      for (const project of fresh) { seen.add(project.id); projects.push(project); }
      lastId = page.projects.at(-1)?.id;
    } while (projects.length < totalSize);
    return { projects, totalSize, complete: true };
  }

  async downloadBytes(path: string, timeout = 60000, allowHtml = false) {
    let url = new URL(path, baseUrl);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.origin !== new URL(baseUrl).origin) throw new Error('Download redirected outside the configured Overleaf origin');
      if (/\/login(?:[/?#]|$)/.test(url.pathname)) throw new AuthenticationError('Download requires a valid session');
      const response = await this.context.request.get(url.href, { timeout, maxRedirects: 0 }).catch(error => { throw new Error(safeErrorMessage(error)); });
      try {
        if (response.status() === 401) throw new AuthenticationError('Download requires a valid session');
        if ([301, 302, 303, 307, 308].includes(response.status())) {
          const location = response.headers().location;
          if (!location) throw new Error('Download redirect has no destination');
          url = new URL(location, url);
          continue;
        }
        if (!response.ok()) throw new Error(`Overleaf download returned HTTP ${response.status()}`);
        const mimeType = (response.headers()['content-type'] ?? 'application/octet-stream').split(';')[0];
        if (mimeType === 'text/html' && !allowHtml) throw new Error('Overleaf returned an HTML page instead of a file');
        const maxBytes = 512 * 1024 * 1024;
        if (Number(response.headers()['content-length']) > maxBytes) throw new Error('Download exceeds 512 MiB');
        const bytes = await response.body();
        if (bytes.length > maxBytes) throw new Error('Download exceeds 512 MiB');
        await saveSession(this.context);
        return { bytes, mimeType };
      } finally { await response.dispose(); }
    }
    throw new Error('Too many download redirects');
  }

  async downloadProject(projectId: string, historyVersion?: number) {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    const route = historyVersion === undefined ? `/project/${projectId}/download/zip` : `/project/${projectId}/version/${historyVersion}/zip`;
    const { bytes } = await this.downloadBytes(route, 120000);
    if (bytes.subarray(0, 2).toString() !== 'PK') throw new Error('The project response is not a ZIP archive');
    return { projectId, historyVersion, artifact: await saveArtifact(`project-${historyVersion ?? 'current'}.zip`, bytes, 'application/zip') };
  }

  async downloadFile(projectId: string, path: string) {
    const project = await this.getProject(projectId);
    const file = project.files.find(f => f.path === path);
    if (!file) throw new Error(`File not found: ${path}`);
    if (file.kind === 'doc') {
      const snapshot = await this.readFile(projectId, path);
      return { projectId, path, version: snapshot.version, artifact: await saveArtifact(path, Buffer.from(snapshot.content), 'text/plain') };
    }
    const { bytes, mimeType } = await this.downloadBytes(`/project/${projectId}/file/${file.id}`, 60000, /\.(html?|xhtml)$/i.test(path));
    const detectedMime = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : mimeType;
    return { projectId, path, artifact: await saveArtifact(path, bytes, detectedMime) };
  }

  async compileRemote(projectId: string, rootPath?: string, compiler?: string, timeoutSeconds = 120) {
    const project = await this.getProject(projectId);
    const root = rootPath ? project.files.find(file => file.path === rootPath && file.kind === 'doc') : project.files.find(file => file.id === project.rootDocId);
    if (!root) throw new Error('Main document not found; provide rootPath');
    const editorId = randomUUID();
    const result = await this.request(`/project/${projectId}/compile?file_line_errors=true`, 'POST', {
      rootDoc_id: root.id, rootResourcePath: root.path, editorId, check: 'silent', stopOnFirstError: true, ...(compiler ? { compiler } : {}),
    }, timeoutSeconds * 1000);
    const outputs = [];
    for (const file of result.outputFiles ?? []) {
      if (!['output.pdf', 'output.log', 'output.bbl', 'output.blg'].includes(file.path)) continue;
      const url = new URL(file.url, baseUrl);
      if (result.clsiServerId) url.searchParams.set('clsiserverid', result.clsiServerId);
      if (result.compileGroup) url.searchParams.set('compileGroup', result.compileGroup);
      url.searchParams.set('editorId', editorId);
      try {
        const { bytes, mimeType } = await this.downloadBytes(url.href);
        if (file.path === 'output.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid PDF response');
        outputs.push(await saveArtifact(file.path, bytes, file.path.endsWith('.pdf') ? 'application/pdf' : mimeType));
      } catch (error) { outputs.push({ filename: file.path, error: safeErrorMessage(error) }); }
    }
    const hasPdf = outputs.some(file => file.filename === 'output.pdf' && 'size' in file);
    return { projectId, mode: 'remote', status: result.status === 'success' && !hasPdf ? 'output-unavailable' : result.status, compileStatus: result.status, rootPath: root.path, compiler: compiler ?? project.compiler,
      buildId: (result.outputFiles ?? []).map((file: any) => /\/build\/([^/]+)\//.exec(file.url)?.[1]).find(Boolean),
      outputs, timings: result.timings, validationProblems: result.validationProblems, completedAt: new Date().toISOString() };
  }

  private async project(projectId: string): Promise<ProjectConnection> {
    if (this.closed) throw new Error('Overleaf client is closed');
    if (this.authenticationLost) throw new AuthenticationError('Authentication required. Run overleaf-mcp login (or npm run login from the source checkout).');
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    let pending = this.projects.get(projectId);
    if (!pending) {
      pending = this.openProject(projectId);
      this.projects.set(projectId, pending);
    }
    try {
      const connection = await pending;
      if (connection.dirtyTree || connection.page.isClosed()) {
        if (this.projects.get(projectId) === pending) {
          // Install the replacement promise before awaiting close so concurrent
          // readers share one replacement instead of closing each other's pages.
          const replacement = connection.page.close().then(() => this.openProject(projectId));
          this.projects.set(projectId, replacement);
        }
        return this.project(projectId);
      }
      return connection;
    } catch (error) {
      if (this.projects.get(projectId) === pending) this.projects.delete(projectId);
      throw error;
    }
  }

  private async openProject(projectId: string) {
    const page = await this.context.newPage();
    // The full editor may auto-compile or normalize document text on opening.
    // A read-only connection needs the instance's Socket.IO library, not its editor app.
    await page.route('**/*', route => {
      const request = route.request();
      const socketLibrary = new URL(request.url()).pathname.endsWith('/socket.io/socket.io.js');
      return request.resourceType() === 'script' && !socketLibrary ? route.abort() : route.continue();
    });
    const connection = { page, dirtyTree: false };
    await page.exposeFunction('__overleafMcpEvent', (event: any) => {
      if (['collaborationChanged', 'presenceChanged', 'reviewChanged'].includes(event.event)) {
        this.emit(event.event, { projectId, receivedAt: new Date().toISOString() });
      }
      if (event.event === 'treeChanged' && !event.applied) connection.dirtyTree = true;
      if (event.event === 'disconnected') {
        for (const watch of this.watches.values()) if (watch.projectId === projectId) {
          watch.current = { ...watch.current, live: false };
          this.emit('change', { projectId, path: watch.path, live: false, reason: 'disconnected' });
        }
      }
      if (['documentChanged', 'connected', 'treeChanged'].includes(event.event)) {
        for (const watch of this.watches.values()) if (watch.projectId === projectId && (!event.docId || !watch.docId || event.docId === watch.docId)) {
          watch.dirty = true;
          void this.refreshWatch(watch);
        }
      }
    });
    try {
      const response = await page.goto(`${baseUrl}/project/${projectId}`, { waitUntil: 'domcontentloaded' });
      if (response && !response.ok()) throw new Error(`Opening the project returned HTTP ${response.status()}`);
      await page.waitForFunction(() => Boolean((window as any).io), undefined, { timeout: 30000 });
      await page.evaluate(installLiveBridge, projectId);
      await page.waitForFunction(() => (window as any).__overleafMcp?.project || (window as any).__overleafMcp?.error, undefined, { timeout: 30000 });
      const error = await page.evaluate(() => (window as any).__overleafMcp.error);
      if (error) throw new Error(error);
      return connection;
    } catch (error) { await page.close(); throw error; }
  }

  async getProject(projectId: string): Promise<ProjectSummary> {
    const conn = await this.project(projectId);
    const data = await conn.page.evaluate(() => {
      const b = (window as any).__overleafMcp;
      if (!b.connected) throw new Error('Realtime connection is disconnected');
      const p = b.project;
      return { id: p._id, name: p.name, rootFolder: p.rootFolder, rootDocId: p.rootDoc_id ?? p.rootDocId, compiler: p.compiler, spellCheckLanguage: p.spellCheckLanguage };
    });
    const { rootFolder, ...summary } = data;
    return { ...summary, files: flattenFiles(rootFolder), folders: flattenFolders(rootFolder) };
  }

  async readFile(projectId: string, path: string, startLine?: number, endLine?: number) {
    const project = await this.getProject(projectId);
    const file = project.files.find(f => f.path === path);
    if (!file) throw new Error(`File not found: ${path}`);
    if (file.kind !== 'doc') throw new Error('This is an uploaded/binary file, not a live text document');
    const { page } = await this.project(projectId);
    const { ranges: _ranges, reviewComments: _comments, reviewChanges: _changes, ...snapshot } = await page.evaluate(readLiveDocument, file.id);
    return { projectId, path, ...snapshot, ...selectLines(snapshot.content, startLine, endLine) };
  }

  async writeFile(projectId: string, path: string, expectedDocId: string, expectedVersion: number, change: { content: string } | { oldText: string; newText: string }) {
    const key = `${projectId}:${path}`;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const before = await this.readFile(projectId, path);
      if (before.docId !== expectedDocId || before.version !== expectedVersion) throw new Error('VERSION_CONFLICT: read the file again before writing');
      const content = 'content' in change ? change.content : replaceExact(before.content, change.oldText, change.newText);
      const op = textEditOperation(before.content, content, before.type);
      if (!op.length) return { applied: false, unchanged: true, ...before };
      const { page } = await this.project(projectId);
      const acknowledgment = await page.evaluate(submitDocumentEdit, { docId: before.docId, version: before.version, type: before.type, op });
      let after;
      try { after = await this.readFile(projectId, path); }
      catch (error) { return { applied: true, ...acknowledgment, verified: false, error: safeErrorMessage(error), projectId, path }; }
      if (after.docId !== before.docId || after.version < acknowledgment.acceptedVersion) {
        return { applied: true, ...acknowledgment, verified: false, projectId, path, docId: before.docId,
          observedDocId: after.docId, observedVersion: after.version, error: 'The path or version changed after the write; read the project again' };
      }
      return { applied: true, ...acknowledgment, concurrentChanges: acknowledgment.concurrentChanges || after.version !== acknowledgment.acceptedVersion, verified: true, matchesRequestedContent: after.content === content, ...after };
    });
    this.writes.set(key, pending);
    try { return await pending; } finally { if (this.writes.get(key) === pending) this.writes.delete(key); }
  }

  async createFile(projectId: string, name: string, parentFolderId?: string) {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Provide a filename without directory separators');
    const created = await this.request(`/project/${projectId}/doc`, 'POST', { name, ...(parentFolderId ? { parent_folder_id: parentFolderId } : {}) });
    const connection = this.projects.get(projectId);
    if (connection) (await connection).dirtyTree = true;
    return created;
  }

  async uploadFile(projectId: string, localPath: string, path?: string, overwrite = false) {
    const target = uploadDestination(localPath, path);
    const key = `${projectId}:${target.path}`;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.performUpload(projectId, localPath, target, overwrite));
    this.writes.set(key, pending);
    try { return await pending; } finally { if (this.writes.get(key) === pending) this.writes.delete(key); }
  }

  private async performUpload(projectId: string, localPath: string, target: ReturnType<typeof uploadDestination>, overwrite: boolean) {
    const project = await this.getProject(projectId);
    const folder = project.folders?.find(folder => folder.path === target.folderPath);
    if (!folder) throw new Error(`Destination folder does not exist: ${target.folderPath || '/'}`);
    const existing = project.files.find(file => file.path === target.path);
    if (project.folders?.some(folder => folder.path === target.path)) throw new Error('The destination is a folder');
    if (existing && !overwrite) throw new Error('FILE_EXISTS: set overwrite=true to replace the existing file');
    const settings = await this.dashboard.evaluate(() => {
      const meta = document.querySelector('meta[name="ol-ExposedSettings"]')?.getAttribute('content');
      const exposed = meta ? JSON.parse(meta) : {};
      const maximum = exposed.maxUploadSize;
      return { csrf: document.querySelector('meta[name="ol-csrfToken"]')?.getAttribute('content') ?? '', maxBytes: Number.isSafeInteger(maximum) && maximum > 0 ? maximum : 50 * 1024 * 1024, editableFilenames: exposed.editableFilenames ?? [], textExtensions: exposed.textExtensions ?? [] };
    });
    const source = await loadUpload(localPath, settings.maxBytes);
    // The upload endpoint upserts unconditionally. A unique staging name plus
    // a locked rename gives create-only behavior when overwrite is false.
    const namedTextFile = settings.editableFilenames?.some((name: string) => name.toLowerCase() === target.name.toLowerCase());
    const stagingPrefix = `mcp-upload-${randomUUID()}`;
    let stagingExtension = namedTextFile ? '.txt' : posix.extname(target.name);
    if (stagingPrefix.length + stagingExtension.length >= 150) {
      const editableExtension = settings.textExtensions?.some((extension: string) => extension.toLowerCase() === stagingExtension.slice(1).toLowerCase());
      stagingExtension = editableExtension ? '.txt' : '.bin';
    }
    const uploadName = overwrite ? target.name : `${stagingPrefix}${stagingExtension}`;
    const stagingPath = target.folderPath ? `${target.folderPath}/${uploadName}` : uploadName;
    let response;
    try {
      response = await this.context.request.post(`${baseUrl}/project/${projectId}/upload?folder_id=${encodeURIComponent(folder.id)}`, {
        headers: { 'X-CSRF-Token': settings.csrf }, maxRedirects: 0, timeout: 120000,
        multipart: { name: uploadName, qqfile: { name: uploadName, mimeType: 'application/octet-stream', buffer: source.buffer } },
      });
    } catch {
      throw new Error(`UPLOAD_STATUS_UNKNOWN: inspect ${stagingPath} before retrying`);
    }
    let uploaded: any;
    try {
      if (response.status() === 401 || (response.status() === 302 && /\/login(?:[?#]|$)/.test(response.headers().location ?? ''))) throw new AuthenticationError('Upload requires a valid session');
      if (!(response.headers()['content-type'] ?? '').includes('application/json')) throw new Error(`UPLOAD_STATUS_UNKNOWN: HTTP ${response.status()}; inspect ${stagingPath} before retrying`);
      uploaded = await response.json();
      if (!response.ok() || uploaded?.success !== true) throw new Error(`Upload failed: ${typeof uploaded?.error === 'string' ? uploaded.error : `HTTP ${response.status()}`}; inspect ${stagingPath} before retrying`);
      if (!/^[a-f\d]{24}$/i.test(uploaded.entity_id) || !['doc', 'file'].includes(uploaded.entity_type)) throw new Error(`UPLOAD_STATUS_UNKNOWN: missing entity information; inspect ${stagingPath}`);
    } finally { await response.dispose(); }
    let placementError: string | undefined;
    if (!overwrite) {
      try { await this.request(`/project/${projectId}/${uploaded.entity_type}/${uploaded.entity_id}/rename`, 'POST', { name: target.name }); }
      catch (error) { placementError = safeErrorMessage(error); }
    }
    const result: any = { uploaded: true, projectId, requestedPath: target.path, entityId: uploaded.entity_id, entityType: uploaded.entity_type,
      overwriteAllowed: overwrite, existingBeforeUpload: existing ? { id: existing.id, kind: existing.kind } : null,
      sourceBytes: source.size, sourceSha256: source.sha256, verified: false, path: stagingPath, placedAtRequestedPath: false };
    try {
      // Wait for the normal tree events instead of reloading the editor per upload.
      let file: ProjectFile | undefined;
      const deadline = Date.now() + 5000;
      do {
        const fresh = await this.getProject(projectId);
        file = fresh.files.find(file => file.id === uploaded.entity_id);
        if (file && (file.path === target.path || placementError)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      if (!file || (!placementError && file.path !== target.path)) {
        const current = this.projects.get(projectId);
        if (current) (await current).dirtyTree = true;
        file = (await this.getProject(projectId)).files.find(file => file.id === uploaded.entity_id);
      }
      if (!file) throw new Error('Uploaded entity was not found in the current file tree');
      result.path = file.path;
      result.placedAtRequestedPath = file.path === target.path;
      if (file.kind === 'doc') {
        const snapshot = await this.readFile(projectId, file.path);
        if (snapshot.docId !== uploaded.entity_id) throw new Error('The uploaded path now points to another document');
        result.contentMatch = uploadedTextMatches(source.buffer, snapshot.content);
        result.version = snapshot.version;
        result.serverSha256 = createHash('sha256').update(snapshot.content).digest('hex');
      } else {
        const { bytes } = await this.downloadBytes(`/project/${projectId}/file/${file.id}`, 60000, /\.(html?|xhtml)$/i.test(file.path));
        result.serverSha256 = createHash('sha256').update(bytes).digest('hex');
        result.contentMatch = result.serverSha256 === source.sha256 ? 'exact' : 'different';
      }
      result.verified = result.placedAtRequestedPath && result.contentMatch !== 'different';
      if (!result.placedAtRequestedPath) result.error = placementError ?? 'The uploaded file moved before verification';
      if (result.contentMatch === 'different') result.warning = 'Upload was accepted, but server content differs; inspect before retrying';
    } catch (error) { result.error = safeErrorMessage(error); }
    try { await saveSession(this.context); }
    catch { result.sessionWarning = 'Upload result was checked, but the refreshed session could not be saved'; }
    return result;
  }

  async watchFile(projectId: string, path: string) {
    if (this.closed) throw new Error('Overleaf client is closed');
    if (this.authenticationLost) throw new AuthenticationError('Authentication required. Run overleaf-mcp login (or npm run login from the source checkout).');
    const key = `${projectId}:${path}`;
    let watch = this.watches.get(key);
    if (!watch) {
      watch = { projectId, path, current: undefined, dirty: true };
      this.watches.set(key, watch);
    }
    if (watch.current?.live === false) watch.dirty = true;
    if (watch.dirty || watch.refresh) await this.refreshWatch(watch);
    if (this.watches.get(key) !== watch || this.closed) throw new Error('Watch was stopped');
    return { watchId: key, ...watch.current };
  }

  private refreshWatch(watch: Watch): Promise<void> {
    if (watch.refresh) return watch.refresh;
    watch.refresh = this.performRefresh(watch).finally(() => { watch.refresh = undefined; });
    return watch.refresh;
  }

  private async performRefresh(watch: Watch) {
    const active = () => !this.closed && this.watches.get(`${watch.projectId}:${watch.path}`) === watch;
    try {
      while (watch.dirty && active()) {
        watch.dirty = false;
        const current = await this.readFile(watch.projectId, watch.path);
        if (!active()) return;
        watch.docId = current.docId;
        const changed = !watch.current || current.docId !== watch.current.docId || current.version !== watch.current.version || current.content !== watch.current.content || !watch.current.live;
        watch.current = current;
        if (changed) this.emit('change', current);
      }
    } catch (error) {
      if (!active()) return;
      watch.current = { projectId: watch.projectId, path: watch.path, live: false, error: safeErrorMessage(error) };
      this.emit('change', { projectId: watch.projectId, path: watch.path, ...watch.current });
    }
  }

  unwatchFile(watchId: string) { return this.watches.delete(watchId); }

  async getCollaboration(projectId: string) {
    const { page } = await this.project(projectId);
    const membership = await this.request(`/project/${projectId}/members`);
    let presence;
    try {
      presence = await page.evaluate(readLivePresence);
    } catch (error) { presence = { status: 'unknown', error: safeErrorMessage(error), observedAt: new Date().toISOString() }; }
    // /members lists explicitly invited collaborators, not everyone who opened
    // an editable sharing link. Presence is an independent observation.
    return { projectId, invitedMembers: membership.members, presence };
  }

  async getReview(projectId: string, path?: string) {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    const project = await this.getProject(projectId);
    const docs = project.files.filter(file => file.kind === 'doc' && (!path || file.path === path));
    if (path && !docs.length) throw new Error(`Text file not found: ${path}`);
    const files = [];
    const unavailable = [];
    for (const doc of docs) {
      try {
        const { page } = await this.project(projectId);
        files.push(documentReview(doc.path, await page.evaluate(readLiveDocument, doc.id)));
      } catch (error) { unavailable.push({ path: doc.path, error: safeErrorMessage(error) }); }
    }
    return { projectId, threads: await this.request(`/project/${projectId}/threads`), files, unavailable, complete: unavailable.length === 0, observedAt: new Date().toISOString() };
  }

  async replyToComment(projectId: string, threadId: string, content: string) {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    if (!/^[a-f\d]{24}$/i.test(threadId)) throw new Error('Invalid comment thread ID');
    if (!content.trim()) throw new Error('Reply content must not be empty');
    const threadsPath = `/project/${projectId}/threads`;
    const threads = await this.request(threadsPath);
    // The POST endpoint can also create threads; a reply must target an existing one.
    if (!threads[threadId]) throw new Error('Comment thread not found. Check get_review to find an existing thread.');
    try {
      await this.request(`/project/${projectId}/thread/${threadId}/messages`, 'POST', { content });
    } catch (error: any) {
      if (error instanceof AuthenticationError || (error.status >= 400 && error.status < 500)) throw error;
      throw new Error(`REPLY_STATUS_UNKNOWN: ${safeErrorMessage(error)}; check get_review before retrying`);
    }
    const posted = { projectId, threadId, posted: true };
    try {
      return { ...posted, thread: (await this.request(threadsPath))[threadId] ?? null };
    } catch (error) {
      return { ...posted, thread: null, readBackError: safeErrorMessage(error) };
    }
  }

  private async reviewWrite<T>(projectId: string, path: string, run: () => Promise<T>): Promise<T> {
    const key = `${projectId}:${path}`;
    const pending = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    this.writes.set(key, pending);
    try { return await pending; } finally { if (this.writes.get(key) === pending) this.writes.delete(key); }
  }

  private async reviewSnapshot(projectId: string, path: string, expectedDocId?: string, expectedVersion?: number) {
    const project = await this.getProject(projectId);
    const file = project.files.find(file => file.path === path && file.kind === 'doc');
    if (!file) throw new Error("Choose a text file from get_project.");
    const { page } = await this.project(projectId);
    const snapshot = await page.evaluate(readLiveDocument, file.id);
    if ((expectedDocId !== undefined && snapshot.docId !== expectedDocId) || (expectedVersion !== undefined && snapshot.version !== expectedVersion)) {
      throw new Error("VERSION_CONFLICT: read the file and its review data again.");
    }
    return { page, snapshot };
  }

  private async reviewThread(projectId: string, threadId: string) {
    if (!/^[a-f\d]{24}$/i.test(projectId) || !/^[a-f\d]{24}$/i.test(threadId)) throw new Error("Use project and thread IDs returned by get_review.");
    const thread = (await this.request(`/project/${projectId}/threads`))[threadId];
    if (!thread) throw new Error("Choose an existing thread from get_review.");
    return thread;
  }

  private async submitReviewRequest(path: string, method: string, body?: unknown) {
    try { return await this.request(path, method, body); }
    catch (error: any) {
      if (error instanceof AuthenticationError || (error.status >= 400 && error.status < 500)) throw error;
      throw new Error(`REVIEW_STATUS_UNKNOWN: ${safeErrorMessage(error)}; refresh get_review before retrying`);
    }
  }

  async createComment(projectId: string, path: string, expectedDocId: string, expectedVersion: number, quote: string, content: string) {
    if (!content.trim()) throw new Error("Enter the comment text.");
    return this.reviewWrite(projectId, path, async () => {
      const { page, snapshot } = await this.reviewSnapshot(projectId, path, expectedDocId, expectedVersion);
      const threadId = randomBytes(12).toString('hex');
      const op = commentOperation(snapshot, quote, threadId);
      try { await this.submitReviewRequest(`/project/${projectId}/thread/${threadId}/messages`, 'POST', { content }); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('REVIEW_STATUS_UNKNOWN')) throw new Error(`${error.message}; threadId: ${threadId}`);
        throw error;
      }
      const posted = { projectId, path, docId: snapshot.docId, threadId, posted: true };
      let acknowledgment;
      try { acknowledgment = await page.evaluate(submitDocumentEdit, { docId: snapshot.docId, version: snapshot.version, type: snapshot.type, op }); }
      catch (error) { return { ...posted, anchored: null, verified: false, error: safeErrorMessage(error) }; }
      try {
        const review = await this.getReview(projectId, path);
        const anchored = review.files.some(file => file.docId === snapshot.docId && file.comments.some(comment => comment.threadId === threadId));
        return { ...posted, ...acknowledgment, anchored: true, verified: anchored, review };
      } catch (error) { return { ...posted, ...acknowledgment, anchored: true, verified: false, readBackError: safeErrorMessage(error) }; }
    });
  }

  async editCommentMessage(projectId: string, threadId: string, messageId: string, content: string) {
    if (!content.trim()) throw new Error("Enter the replacement message text.");
    return this.changeCommentMessage(projectId, threadId, messageId, content);
  }

  async deleteCommentMessage(projectId: string, threadId: string, messageId: string) {
    return this.changeCommentMessage(projectId, threadId, messageId);
  }

  private async changeCommentMessage(projectId: string, threadId: string, messageId: string, content?: string) {
    if (!/^[a-f\d]{24}$/i.test(messageId)) throw new Error("Use a message ID returned by get_review.");
    const before = await this.reviewThread(projectId, threadId);
    const previousMessage = before.messages.find((message: any) => message.id === messageId);
    if (!previousMessage) throw new Error("Choose an existing message from get_review.");
    const deleting = content === undefined;
    const currentUserId = deleting ? await this.dashboard.evaluate(() => document.querySelector('meta[name="ol-user_id"]')?.getAttribute('content')) : undefined;
    const ownMessage = currentUserId && previousMessage.user_id === currentUserId;
    const url = `/project/${projectId}/thread/${threadId}/${ownMessage ? 'own-messages' : 'messages'}/${messageId}`;
    await this.submitReviewRequest(deleting ? url : `${url}/edit`, deleting ? 'DELETE' : 'POST', deleting ? undefined : { content });
    const result = { projectId, threadId, messageId, applied: true };
    try {
      const thread = (await this.request(`/project/${projectId}/threads`))[threadId] ?? null;
      const message = thread?.messages.find((message: any) => message.id === messageId);
      return { ...result, verified: deleting ? !message : message?.content === content, thread };
    } catch (error) { return { ...result, verified: false, readBackError: safeErrorMessage(error) }; }
  }

  async changeCommentThread(projectId: string, path: string, threadId: string, action: 'resolve' | 'reopen' | 'delete') {
    return this.reviewWrite(projectId, path, async () => {
      await this.reviewThread(projectId, threadId);
      const { snapshot } = await this.reviewSnapshot(projectId, path);
      if (!documentReview(path, snapshot).comments.some(comment => comment.threadId === threadId)) {
        const all = await this.getReview(projectId);
        const location = all.files.find(file => file.comments.some(comment => comment.threadId === threadId));
        if (location) throw new Error(`Use path ${location.path} for this comment thread.`);
        if (action !== 'delete' || !all.complete) throw new Error("Refresh get_review to select the comment location.");
      }
      const url = `/project/${projectId}/doc/${snapshot.docId}/thread/${threadId}`;
      await this.submitReviewRequest(action === 'delete' ? url : `${url}/${action}`, action === 'delete' ? 'DELETE' : 'POST');
      const result = { projectId, path, docId: snapshot.docId, threadId, action, applied: true };
      try {
        const review = await this.getReview(projectId, path);
        const thread = review.threads[threadId];
        const verified = action === 'delete'
          ? !thread && review.complete && review.files.every(file => file.comments.every(comment => comment.threadId !== threadId))
          : Boolean(thread) && Boolean(thread.resolved) === (action === 'resolve');
        return { ...result, verified, review };
      } catch (error) { return { ...result, verified: false, readBackError: safeErrorMessage(error) }; }
    });
  }

  async decideTrackedChanges(projectId: string, path: string, expectedDocId: string, expectedVersion: number, changeIds: string[], action: 'accept' | 'reject') {
    return this.reviewWrite(projectId, path, async () => {
      const { page, snapshot } = await this.reviewSnapshot(projectId, path, expectedDocId, expectedVersion);
      const plan = trackedChangePlan(snapshot, changeIds, action);
      let acknowledgment;
      if (snapshot.type === 'sharejs-text-ot' && action === 'accept') {
        await this.submitReviewRequest(`/project/${projectId}/doc/${snapshot.docId}/changes/accept`, 'POST', { change_ids: [...new Set(changeIds)] });
      } else {
        acknowledgment = await page.evaluate(submitDocumentEdit, { docId: snapshot.docId, version: snapshot.version, type: snapshot.type, op: plan.op,
          ...(snapshot.type === 'sharejs-text-ot' ? { expectedChangeIds: changeIds } : {}) });
      }
      const result = { projectId, path, docId: snapshot.docId, changeIds, action, applied: true, ...acknowledgment };
      try {
        const after = (await this.reviewSnapshot(projectId, path)).snapshot;
        const review = documentReview(path, after);
        const verified = after.docId === snapshot.docId && (acknowledgment
          ? after.version >= acknowledgment.acceptedVersion
          : review.trackedChanges.every(change => !changeIds.includes(change.id)));
        return { ...result, verified, matchesRequestedContent: after.content === plan.expectedContent, content: after.content, version: after.version, review };
      } catch (error) { return { ...result, verified: false, readBackError: safeErrorMessage(error) }; }
    });
  }

  async history(projectId: string, before?: string) {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    // No locally imposed time window; preserve the API's pagination and errors.
    return this.request(`/project/${projectId}/updates${before ? `?before=${encodeURIComponent(before)}` : ''}`);
  }

  async historyLabels(projectId: string) {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    return { projectId, labels: await this.request(`/project/${projectId}/labels`) };
  }

  async historyDiff(projectId: string, from: number, to: number, path?: string) {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid project ID');
    const query = new URLSearchParams({ from: String(from), to: String(to), ...(path ? { pathname: path } : {}) });
    return this.request(`/project/${projectId}/${path ? 'diff' : 'filetree/diff'}?${query}`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearTimeout(this.keepalive);
    this.watches.clear();
    this.emit('closed');
    await this.browser.close();
  }
}
