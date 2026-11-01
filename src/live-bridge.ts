// Runs inside an authenticated editor page. Uses that deployment's own Socket.IO
// client so old self-hosted instances and the official service can negotiate alike.
export async function installLiveBridge(projectId: string) {
  const w = window as any;
  if (w.__overleafMcp) return;
  const io = w.io;
  if (!io) throw new Error('Overleaf Socket.IO client is unavailable');
  const endpoint = new URL(document.querySelector('meta[name="ol-wsUrl"]')?.getAttribute('content') || '/socket.io', location.origin);
  const legacy = typeof io.version === 'string' && io.version.startsWith('0');
  const options = {
    query: `projectId=${encodeURIComponent(projectId)}`,
    resource: endpoint.pathname.slice(1),
    path: endpoint.pathname,
    'force new connection': true,
    forceNew: true,
    reconnect: true,
    reconnection: true,
    'connect timeout': 15000,
    timeout: 15000,
  };
  const socket = legacy ? io.connect(endpoint.origin, options) : io.Manager(endpoint.origin, options).socket('/', options);
  const bridge = w.__overleafMcp = {
    socket,
    connected: false,
    project: null as any,
    publicId: null as string | null,
    error: null as string | null,
    generation: 0,
    rpc(event: string, ...args: any[]): Promise<any[]> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 15000);
        socket.emit(event, ...args, (error: any, ...values: any[]) => {
          clearTimeout(timer);
          if (error) reject(new Error(typeof error === 'string' ? error : error.message ?? 'Overleaf request failed'));
          else resolve(values);
        });
      });
    },
  };
  const notify = (event: string, data: any = {}) => void w.__overleafMcpEvent({ event, ...data }).catch(() => {});
  socket.on('joinProjectResponse', (payload: any) => {
    bridge.connected = true;
    bridge.error = null;
    bridge.project = payload.project;
    bridge.publicId = payload.publicId;
    bridge.generation++;
    notify('connected');
  });
  socket.on('disconnect', () => { bridge.connected = false; notify('disconnected'); });
  socket.on('connectionRejected', (error: any) => {
    bridge.connected = false;
    bridge.error = error?.message ?? 'Connection rejected';
    notify('disconnected');
  });
  for (const [event, field] of [
    ['rootDocUpdated', 'rootDoc_id'], ['compilerUpdated', 'compiler'],
    ['projectNameUpdated', 'name'], ['spellCheckLanguageUpdated', 'spellCheckLanguage'],
    ['imageNameUpdated', 'imageName'],
  ]) {
    socket.on(event, (value: any) => { if (bridge.project) bridge.project[field] = value; });
  }
  socket.on('otUpdateApplied', (update: any) => notify('documentChanged', { docId: update.doc, version: update.v }));
  socket.on('project:membership:changed', () => notify('collaborationChanged'));
  socket.on('clientTracking.clientUpdated', () => notify('presenceChanged'));
  socket.on('clientTracking.clientDisconnected', () => notify('presenceChanged'));
  for (const event of ['new-comment', 'edit-message', 'delete-message', 'resolve-thread', 'reopen-thread', 'delete-thread', 'new-comment-threads']) {
    socket.on(event, () => notify('reviewChanged'));
  }
  const folders = () => Array.isArray(bridge.project?.rootFolder) ? bridge.project.rootFolder : bridge.project?.rootFolder ? [bridge.project.rootFolder] : [];
  const findFolder = (id: string, roots = folders()): any => {
    for (const folder of roots) {
      if (String(folder._id) === String(id)) return folder;
      const found = findFolder(id, folder.folders ?? []);
      if (found) return found;
    }
  };
  const findEntity = (id: string, roots = folders()): any => {
    for (const folder of roots) {
      for (const key of ['docs', 'fileRefs', 'folders']) {
        const index = (folder[key] ?? []).findIndex((entity: any) => String(entity._id) === String(id));
        if (index >= 0) return { folder, key, index, entity: folder[key][index] };
      }
      const found = findEntity(id, folder.folders ?? []);
      if (found) return found;
    }
  };
  for (const [event, key] of [['reciveNewDoc', 'docs'], ['reciveNewFile', 'fileRefs'], ['reciveNewFolder', 'folders']]) {
    socket.on(event, (parentId: string, entity: any) => {
      const parent = findFolder(parentId);
      if (!parent || !entity?._id) { notify('treeChanged', { applied: false }); return; }
      parent[key] ??= [];
      const index = parent[key].findIndex((item: any) => String(item._id) === String(entity._id));
      if (index < 0) parent[key].push(entity); else parent[key][index] = entity;
      notify('treeChanged', { applied: true });
    });
  }
  socket.on('reciveEntityRename', (id: string, name: string) => {
    const found = findEntity(id);
    if (found) found.entity.name = name;
    notify('treeChanged', { applied: Boolean(found) });
  });
  socket.on('reciveEntityMove', (id: string, parentId: string) => {
    const found = findEntity(id), parent = findFolder(parentId);
    if (found && parent) {
      found.folder[found.key].splice(found.index, 1);
      parent[found.key] ??= [];
      parent[found.key].push(found.entity);
    }
    notify('treeChanged', { applied: Boolean(found && parent) });
  });
  socket.on('removeEntity', (id: string) => {
    const found = findEntity(id);
    if (found) found.folder[found.key].splice(found.index, 1);
    notify('treeChanged', { applied: true });
  });
  socket.on('serverPing', (...args: any[]) => socket.emit('clientPong', ...args,
    legacy ? socket.socket?.transport?.name : socket.io?.engine?.transport?.name,
    legacy ? socket.socket?.sessionid : socket.id));
}

export async function readLiveDocument(docId: string) {
  const bridge = (window as any).__overleafMcp;
  if (!bridge?.connected) throw new Error('Realtime connection is disconnected; no cached content returned');
  const generation = bridge.generation;
  const [lines, version, , ranges, type = 'sharejs-text-ot'] = await bridge.rpc('joinDoc', docId, -1, { supportsHistoryOT: true, encodeRanges: true });
  if (!bridge.connected || generation !== bridge.generation) throw new Error('Connection changed during document read; retry');
  if (!Number.isInteger(version) || version < 0) throw new Error('Document snapshot has no valid version');
  if (!['sharejs-text-ot', 'history-ot'].includes(type)) throw new Error(`Unsupported document type: ${type}`);
  // Legacy ShareLaTeX encodes Unicode as UTF-8 bytes in JS strings; history-ot
  // returns StringFileRawData {content, comments, trackedChanges}.
  let text: string;
  if (type === 'sharejs-text-ot') {
    if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) throw new Error(`Unsupported snapshot format: ${type}`);
    text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(lines.join('\n'), c => c.charCodeAt(0)));
  } else {
    if (!lines || typeof lines.content !== 'string') throw new Error(`Unsupported snapshot format: ${type}`);
    text = lines.content;
  }
  const hasTrackedChanges = type === 'history-ot' ? Boolean(lines.trackedChanges?.length) : Boolean(ranges?.changes?.length);
  return { docId, content: text, version, type, ranges, hasTrackedChanges,
    reviewComments: type === 'history-ot' ? lines.comments : undefined,
    reviewChanges: type === 'history-ot' ? lines.trackedChanges : undefined,
    receivedAt: new Date().toISOString(), live: true };
}

export async function readLivePresence() {
  const bridge = (window as any).__overleafMcp;
  if (!bridge?.connected) throw new Error('Realtime connection is disconnected');
  const generation = bridge.generation;
  const [clients] = await bridge.rpc('clientTracking.getConnectedUsers');
  if (!bridge.connected || bridge.generation !== generation) throw new Error('Connection changed while reading presence');
  if (!Array.isArray(clients)) throw new Error('Invalid online user response');
  const currentUserId = document.querySelector('meta[name="ol-user_id"]')?.getAttribute('content');
  const users = new Map<string, any>();
  for (const client of clients) {
    const id = client.user_id;
    if (!id) continue;
    const user = users.get(id) ?? { userId: id, name: `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim(), isCurrentUser: id === currentUserId, connections: 0, documents: [] };
    user.connections++;
    if (client.cursorData?.doc_id && !user.documents.includes(client.cursorData.doc_id)) user.documents.push(client.cursorData.doc_id);
    users.set(id, user);
  }
  return { status: 'available', users: [...users.values()], observedAt: new Date().toISOString() };
}

export async function submitDocumentEdit(input: { docId: string; version: number; type: string; op: unknown[]; expectedChangeIds?: string[] }) {
  const bridge = (window as any).__overleafMcp;
  if (!bridge?.connected || !bridge.publicId) throw new Error('Realtime connection is unavailable for writing');
  bridge.uncertainWrites ??= new Set<string>();
  if (bridge.uncertainWrites.has(input.docId)) throw new Error('WRITE_STATUS_UNKNOWN: a previous write is unresolved on this connection; reconnect the MCP server and inspect the file before writing again');
  const generation = bridge.generation;
  const [, version, , ranges, type = 'sharejs-text-ot'] = await bridge.rpc('joinDoc', input.docId, -1, { supportsHistoryOT: true, encodeRanges: true });
  if (!bridge.connected || generation !== bridge.generation) throw new Error('Connection changed before write; no update submitted');
  if (version !== input.version || type !== input.type) throw new Error('VERSION_CONFLICT: file changed before write; read it again');
  if (input.expectedChangeIds?.some(id => !ranges?.changes?.some((change: any) => change.id === id))) {
    throw new Error("VERSION_CONFLICT: refresh get_review to select current tracked changes.");
  }
  return new Promise<{ acceptedVersion: number; concurrentChanges: boolean }>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      bridge.socket.removeListener('otUpdateApplied', applied);
      bridge.socket.removeListener('otUpdateError', failed);
      bridge.socket.removeListener('disconnect', disconnected);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      if (message.startsWith('WRITE_STATUS_UNKNOWN')) bridge.uncertainWrites.add(input.docId);
      cleanup(); reject(new Error(message));
    };
    const applied = (update: any) => {
      if (settled) return;
      // The sender receives only {v, doc}; other clients receive op and meta.
      const ownAcknowledgment = !Object.hasOwn(update, 'op') || update.meta?.source === bridge.publicId;
      if (update.doc !== input.docId || !ownAcknowledgment || !Number.isInteger(update.v) || update.v < input.version) return;
      settled = true;
      cleanup();
      resolve({ acceptedVersion: update.v + 1, concurrentChanges: update.v !== input.version });
    };
    const failed = (message: string, info: any) => {
      if (info?.doc_id && info.doc_id !== input.docId) return;
      fail(`WRITE_REJECTED: ${message}`);
    };
    const disconnected = () => fail('WRITE_STATUS_UNKNOWN: connection lost; read the file before retrying');
    const timer = setTimeout(() => fail('WRITE_STATUS_UNKNOWN: no applied acknowledgment; read the file before retrying'), 20000);
    bridge.socket.on('otUpdateApplied', applied);
    bridge.socket.on('otUpdateError', failed);
    bridge.socket.on('disconnect', disconnected);
    // The RPC callback only acknowledges queueing. Success requires otUpdateApplied.
    void bridge.rpc('applyOtUpdate', input.docId, { doc: input.docId, v: input.version, op: input.op }).catch((error: Error) => fail(`WRITE_STATUS_UNKNOWN: ${error.message}; read before retrying`));
  });
}
