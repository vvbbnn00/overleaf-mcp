import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installLiveBridge, readLiveDocument, readLivePresence } from '../src/live-bridge.js';
import { flattenFiles } from '../src/model.js';

function setWindow(value: unknown) { (globalThis as any).window = value; }

test('legacy snapshot preserves Chinese, emoji and line endings', async () => {
  const expected = '中文 😀\n  \\section{Résumé}\n\n';
  const encoded = Buffer.from(expected, 'utf8').toString('latin1');
  setWindow({ __overleafMcp: { connected: true, generation: 1, rpc: async () => [encoded.split('\n'), 17, [], {}, 'sharejs-text-ot'] } });
  const result = await readLiveDocument('doc');
  assert.equal(result.content, expected);
  assert.equal(result.version, 17);
  assert.equal(result.live, true);
});

test('history-ot snapshot is not decoded as legacy UTF-8 a second time', async () => {
  // Official StringFileRawData is an object, despite the frontend's old string[] annotation.
  setWindow({ __overleafMcp: { connected: true, generation: 1, rpc: async () => [{ content: '中文 😀\ncafé', comments: [], trackedChanges: [] }, 42, [], {}, 'history-ot'] } });
  assert.equal((await readLiveDocument('doc')).content, '中文 😀\ncafé');
});

test('a disconnected or reconnected snapshot cannot be reported as live', async () => {
  const bridge = { connected: false, generation: 1, rpc: async () => { bridge.generation++; return [['stale'], 1]; } };
  setWindow({ __overleafMcp: bridge });
  await assert.rejects(readLiveDocument('doc'), /disconnected/);
  bridge.connected = true;
  await assert.rejects(readLiveDocument('doc'), /Connection changed/);
});

test('push notifications follow the server otUpdateApplied event without submitting edits', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const outbound: string[] = [];
  const notifications: any[] = [];
  const socket = { on: (event: string, fn: (...args: any[]) => any) => handlers.set(event, fn), emit: (event: string) => outbound.push(event) };
  setWindow({ io: { Manager: () => ({ socket: () => socket }) }, __overleafMcpEvent: async (event: any) => { notifications.push(event); } });
  (globalThis as any).document = { querySelector: () => null };
  (globalThis as any).location = { origin: 'https://overleaf.test' };
  await installLiveBridge('test');
  handlers.get('joinProjectResponse')!({ project: { name: 'test' } });
  handlers.get('otUpdateApplied')!({ doc: 'doc', v: 2 });
  handlers.get('disconnect')!();
  assert.deepEqual(notifications, [
    { event: 'connected' },
    { event: 'documentChanged', docId: 'doc', version: 2 },
    { event: 'disconnected' },
  ]);
  assert.ok(!outbound.includes('applyOtUpdate'));
});

test('presence groups multiple tabs by account and distinguishes the collaborator', async () => {
  (globalThis as any).document = { querySelector: () => ({ getAttribute: () => 'owner' }) };
  setWindow({ __overleafMcp: { connected: true, generation: 1, rpc: async () => [[
    { user_id: 'owner', first_name: 'Owner', cursorData: { doc_id: 'main' } },
    { user_id: 'owner', first_name: 'Owner', cursorData: { doc_id: 'main' } },
    { user_id: 'collaborator', first_name: 'Test', cursorData: { doc_id: 'bib' } },
  ]] } });
  const result = await readLivePresence();
  assert.equal(result.users.length, 2);
  assert.equal(result.users[0].connections, 2);
  assert.deepEqual(result.users[0].documents, ['main']);
  assert.equal(result.users[0].isCurrentUser, true);
  assert.equal(result.users[1].isCurrentUser, false);
});

test('presence does not report an empty online list when disconnected', async () => {
  setWindow({ __overleafMcp: { connected: false } });
  await assert.rejects(readLivePresence(), /disconnected/);
});

test('project settings changed in another editor update the cached compile settings', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const socket = { on: (event: string, fn: (...args: any[]) => any) => handlers.set(event, fn), emit: () => {} };
  setWindow({ io: { Manager: () => ({ socket: () => socket }) }, __overleafMcpEvent: async () => {} });
  (globalThis as any).document = { querySelector: () => null };
  (globalThis as any).location = { origin: 'https://overleaf.test' };
  await installLiveBridge('test');
  handlers.get('joinProjectResponse')!({ project: { rootDoc_id: 'old', compiler: 'pdflatex' } });
  handlers.get('rootDocUpdated')?.('new');
  handlers.get('compilerUpdated')?.('xelatex');
  assert.equal((globalThis as any).window.__overleafMcp.project.rootDoc_id, 'new');
  assert.equal((globalThis as any).window.__overleafMcp.project.compiler, 'xelatex');
});

test('file tree events update paths without reloading the editor page', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: any[] = [];
  const socket = { on: (event: string, fn: (...args: any[]) => any) => handlers.set(event, fn), emit: () => {} };
  setWindow({ io: { Manager: () => ({ socket: () => socket }) }, __overleafMcpEvent: async (event: any) => { events.push(event); } });
  (globalThis as any).document = { querySelector: () => null };
  (globalThis as any).location = { origin: 'https://overleaf.test' };
  await installLiveBridge('test');
  const project = { rootFolder: [{ _id: 'root', docs: [], fileRefs: [], folders: [] }] };
  handlers.get('joinProjectResponse')!({ project });
  handlers.get('reciveNewFolder')!('root', { _id: 'folder', name: 'figures', docs: [], fileRefs: [], folders: [] });
  handlers.get('reciveNewFile')!('root', { _id: 'file', name: 'temporary.png' });
  handlers.get('reciveEntityRename')!('file', 'final.png');
  handlers.get('reciveEntityMove')!('file', 'folder');
  assert.deepEqual(flattenFiles(project.rootFolder), [{ id: 'file', path: 'figures/final.png', kind: 'file' }]);
  handlers.get('removeEntity')!('file');
  assert.deepEqual(flattenFiles(project.rootFolder), []);
  assert.ok(events.filter(event => event.event === 'treeChanged').every(event => event.applied === true));
});
