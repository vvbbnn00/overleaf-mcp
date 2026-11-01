import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { AuthenticationError } from '../src/session.js';

const projectId = '0123456789abcdef01234567';
const path = '章节/main.tex';
const uri = `overleaf://projects/${projectId}/files/${encodeURIComponent(path)}`;
const watchId = `${projectId}:${path}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup() {
  const stopped: string[] = [];
  const backend = Object.assign(new EventEmitter(), {
    watchFile: async () => ({ projectId, path, watchId, docId: 'first', version: 1, content: 'text', live: true }),
    unwatchFile: (id: string) => { stopped.push(id); return true; },
    close: async () => { backend.emit('closed'); },
  });
  const host = createMcpServer(async () => backend as any);
  const client = new Client({ name: 'test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await host.server.connect(remote);
  await client.connect(local);
  return { client, backend, stopped, close: async () => { await client.close(); await host.close(); } };
}

test('tool and resource subscriptions remain independent and release their last watch', async () => {
  const { client, stopped, close } = await setup();
  try {
    await client.subscribeResource({ uri });
    await client.callTool({ name: 'watch_file', arguments: { projectId, path } });
    await client.callTool({ name: 'unwatch_file', arguments: { watchId } });
    assert.equal(stopped.length, 0);
    await client.unsubscribeResource({ uri });
    assert.deepEqual(stopped, [watchId]);
  } finally { await close(); }
});

test('canceling a wait removes its listener and temporary watch', async () => {
  const { client, backend, stopped, close } = await setup();
  try {
    const abort = new AbortController();
    const pending = client.callTool({ name: 'wait_for_file_change', arguments: { projectId, path, afterVersion: 1, timeoutSeconds: 1 } }, undefined, { signal: abort.signal });
    await tick();
    abort.abort();
    await assert.rejects(pending);
    await tick();
    assert.equal(backend.listenerCount('change'), 1);
    assert.deepEqual(stopped, [watchId]);
  } finally { await close(); }
});

test('a missing saved session produces a usable status, not a tool error', async () => {
  const host = createMcpServer(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  const client = new Client({ name: 'test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await host.server.connect(remote);
    await client.connect(local);
    const result = await client.callTool({ name: 'get_session_status' });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.authenticated, false);
    assert.equal(result.structuredContent?.reason, 'not-configured');
  } finally { await client.close(); await host.close(); }
});

test('a missing upload file is not reported as a missing login session', async () => {
  const { client, backend, close } = await setup();
  (backend as any).uploadFile = async () => { throw Object.assign(new Error('ENOENT: local source.tex was not found'), { code: 'ENOENT' }); };
  try {
    const result = await client.callTool({ name: 'upload_file', arguments: { projectId, localPath: '/missing/source.tex' } });
    assert.equal(result.isError, true);
    const message = (result.content as any[])[0].text;
    assert.match(message, /source\.tex/);
    assert.doesNotMatch(message, /saved session/);
  } finally { await close(); }
});

test('a replacement file with the same version still wakes a pending wait', async () => {
  const { client, backend, close } = await setup();
  try {
    const pending = client.callTool({ name: 'wait_for_file_change', arguments: { projectId, path, afterVersion: 1, timeoutSeconds: 1 } });
    await tick();
    backend.emit('change', { projectId, path, docId: 'replacement', version: 1, content: 'new', live: true });
    const result = await pending;
    assert.equal(result.structuredContent?.changed, true);
  } finally { await close(); }
});

test('compile jobs reuse identical requests but do not silently change the requested mode', async () => {
  const { client, backend, close } = await setup();
  let complete!: (value: any) => void;
  (backend as any).compileRemote = async () => new Promise(resolve => { complete = resolve; });
  try {
    const first = await client.callTool({ name: 'compile_project', arguments: { projectId, mode: 'remote' } });
    const same = await client.callTool({ name: 'compile_project', arguments: { projectId, mode: 'remote' } });
    assert.equal(same.structuredContent?.jobId, first.structuredContent?.jobId);
    assert.equal(same.structuredContent?.reused, true);
    const different = await client.callTool({ name: 'compile_project', arguments: { projectId, mode: 'local' } });
    assert.equal(different.isError, true);
    complete({ mode: 'remote', status: 'success', outputs: [] });
    await tick();
    const result = await client.callTool({ name: 'get_compile_result', arguments: { jobId: first.structuredContent?.jobId } });
    assert.equal(result.structuredContent?.state, 'completed');
  } finally { await close(); }
});

test('a late authentication failure from an old connection does not close the replacement', async () => {
  const requests: ((error: Error) => void)[] = [];
  let oldClosed = 0, newClosed = 0, connects = 0;
  const oldBackend = Object.assign(new EventEmitter(), {
    listProjects: () => new Promise((_resolve, reject) => requests.push(reject)),
    close: async () => { oldClosed++; },
  });
  const newBackend = Object.assign(new EventEmitter(), {
    listProjects: async () => ({ projects: [], totalSize: 0 }),
    close: async () => { newClosed++; },
  });
  const host = createMcpServer(async () => (++connects === 1 ? oldBackend : newBackend) as any);
  const client = new Client({ name: 'test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await host.server.connect(remote); await client.connect(local);
    const first = client.callTool({ name: 'list_projects' });
    const second = client.callTool({ name: 'list_projects' });
    await tick();
    requests[0](new AuthenticationError('expired'));
    await first;
    assert.equal((await client.callTool({ name: 'list_projects' })).isError, undefined);
    requests[1](new AuthenticationError('old expired request'));
    await second;
    assert.equal(oldClosed, 1);
    assert.equal(newClosed, 0);
  } finally { await client.close(); await host.close(); }
});

test('a failed watch restoration closes the replacement connection', async () => {
  let connects = 0, replacementClosed = 0;
  const old = Object.assign(new EventEmitter(), {
    watchFile: async () => ({ projectId, path, watchId, live: true }),
    listProjects: async () => { throw new AuthenticationError('Session expired'); },
    close: async () => {},
  });
  const replacement = Object.assign(new EventEmitter(), {
    watchFile: async () => { throw new AuthenticationError('Session expired while restoring watches'); },
    close: async () => { replacementClosed++; },
  });
  const host = createMcpServer(async () => (++connects === 1 ? old : replacement) as any);
  const client = new Client({ name: 'reconnect-test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await host.server.connect(remote); await client.connect(local);
    await client.callTool({ name: 'watch_file', arguments: { projectId, path } });
    await client.callTool({ name: 'list_projects' });
    const result = await client.callTool({ name: 'list_projects' });
    assert.equal(result.isError, true);
    assert.equal(replacementClosed, 1);
  } finally { await client.close(); await host.close(); }
});
