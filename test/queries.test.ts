import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OverleafClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';

const projectId = 'a'.repeat(24);
const authorId = 'b'.repeat(24);

async function setup(t: TestContext) {
  const backend = Reflect.construct(OverleafClient, [{ close: async () => {} }, {}, {}]) as OverleafClient;
  const host = createMcpServer(async () => backend);
  const client = new Client({ name: 'query-test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await host.close(); });
  await host.server.connect(remote);
  await client.connect(local);
  const call = (name: string, args?: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const query = async (name: string, args?: Record<string, unknown>) => {
    const response = await call(name, args);
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    assert.ok(response.structuredContent);
    return response.structuredContent as any;
  };
  return { backend, call, query };
}

test('comment filters use thread status, keep unanchored threads project-wide and only read an explicitly selected file', async t => {
  const { backend, call, query } = await setup(t);
  const open = '1'.repeat(24);
  const resolved = '2'.repeat(24);
  const unanchored = '3'.repeat(24);
  const paths = ['main.tex', 'appendix.tex', 'unavailable.tex'];
  const reads: string[] = [];
  backend.getProject = async () => ({ id: projectId, name: 'Review', files: paths.map(path => ({ id: path, path, kind: 'doc' })) });
  (backend as any).project = async () => ({ page: { evaluate: async (_read: unknown, docId: string) => {
    reads.push(docId);
    if (docId === paths[2]) throw new Error('Document unavailable');
    const snapshot = { docId, version: 3, content: 'first\nquoted text' };
    return docId === paths[0]
      ? { ...snapshot, type: 'sharejs-text-ot', ranges: { comments: [{ id: open, op: { p: 6, c: 'quoted' } }] } }
      : { ...snapshot, type: 'history-ot', reviewComments: [{ id: resolved, resolved: false, ranges: [{ pos: 6, length: 6 }] }] };
  } } });
  backend.request = async path => {
    assert.equal(path, `/project/${projectId}/threads`);
    return { [open]: { resolved: false, messages: [] }, [resolved]: { resolved: true, messages: [] }, [unanchored]: { messages: [] } };
  };

  const list = (args: Record<string, unknown> = {}) => query('list_comment_threads', { projectId, ...args });
  assert.deepEqual((await list()).threads.map((thread: any) => thread.threadId), [open, resolved, unanchored]);
  assert.deepEqual((await list({ resolved: false })).threads.map((thread: any) => thread.threadId), [open, unanchored]);
  assert.deepEqual((await list({ resolved: true })).threads.map((thread: any) => thread.threadId), [resolved]);
  assert.equal((await list({ threadId: unanchored })).threads[0].resolved, false);
  assert.deepEqual(reads, []);

  const file = await list({ path: paths[0], resolved: false });
  assert.equal(file.version, 3);
  assert.deepEqual(file.threads.map((thread: any) => thread.threadId), [open]);
  assert.equal(file.threads[0].ranges[0].start.line, 2);
  assert.deepEqual(reads, [paths[0]]);
  const second = await list({ path: paths[1], resolved: true });
  assert.equal(second.threads[0].threadId, resolved);
  assert.equal(second.threads[0].ranges[0].text, 'quoted');
  assert.equal((await list({ path: paths[0], threadId: unanchored })).threads.length, 0);
  assert.equal((await call('list_comment_threads', { projectId, path: paths[2] })).isError, true);
  const snapshot = await query('get_review', { projectId, path: paths[0] });
  assert.deepEqual(Object.keys(snapshot.threads), [open, resolved, unanchored]);
  assert.equal(snapshot.files.length, 1);
  assert.equal((await call('get_review', { projectId, path: '' })).isError, true);
  assert.equal((await call('get_review', { projectId, resolved: false })).isError, true);
  assert.equal((await call('list_comment_threads', { projectId, resolve: false })).isError, true);
});

test('history accepts returned numeric cursors and keeps continuation on filtered empty pages', async t => {
  const { backend, call, query } = await setup(t);
  const base = `/project/${projectId}/updates`;
  const update = { fromV: 1, toV: 2, pathnames: ['old.tex'], project_ops: [{ rename: { pathname: 'old.tex', newPathname: 'new.tex' } }],
    meta: { users: [null, { id: authorId }], start_ts: 100, end_ts: 200 } };
  const requests: string[] = [];
  backend.request = async path => {
    requests.push(path);
    if (path === base) return { updates: [update], nextBeforeTimestamp: 100 };
    assert.ok([`${base}?before=100`, `${base}?before=0`, `${base}?before=old%2Bcursor`].includes(path));
    return { updates: [] };
  };
  const initial = await query('list_history', { projectId, path: 'missing.tex' });
  assert.deepEqual(initial, { updates: [], nextBeforeTimestamp: 100 });
  await query('list_history', { projectId, before: initial.nextBeforeTimestamp });
  await query('list_history', { projectId, before: 0 });
  await query('list_history', { projectId, before: 'old+cursor' });
  assert.deepEqual(requests.slice(1), [`${base}?before=100`, `${base}?before=0`, `${base}?before=old%2Bcursor`]);
  const filtered = await query('list_history', { projectId, path: 'new.tex', authorId, since: '1970-01-01T00:00:00.200Z', until: 200 });
  assert.deepEqual(filtered.updates, [update]);
  assert.deepEqual((await query('list_history', { projectId, authorId: 'other' })).updates, []);
  assert.deepEqual((await query('list_history', { projectId, since: 201 })).updates, []);
  assert.equal((await call('list_history', { projectId, since: 5, until: 2 })).isError, true);
});

test('tracked-only review skips threads and filters by author in both document protocols', async t => {
  const { backend, query } = await setup(t);
  const docs = ['main.tex', 'second.tex'];
  backend.getProject = async () => ({ id: projectId, name: 'Review', files: docs.map(path => ({ path, id: path, kind: 'doc' })) });
  (backend as any).project = async () => ({ page: { evaluate: async (_read: unknown, docId: string) => {
    const snapshot = { docId, version: 1, content: 'text' };
    return docId === docs[0]
      ? { ...snapshot, type: 'sharejs-text-ot', ranges: { changes: [
        { id: 'insert', op: { p: 0, i: 'text' }, metadata: { user_id: authorId } },
        { id: 'delete', op: { p: 0, d: 'old' }, metadata: { user_id: authorId } },
      ] } }
      : { ...snapshot, type: 'history-ot', reviewChanges: [
        { range: { pos: 0, length: 1 }, tracking: { type: 'insert', userId: authorId } },
        { range: { pos: 1, length: 1 }, tracking: { type: 'insert', userId: 'other' } },
      ] };
  } } });
  backend.request = async () => assert.fail('Tracked-only review must not read threads');
  const result = await query('get_review', { projectId, trackedChanges: { kind: 'insert', authorId } });
  assert.equal(result.complete, true);
  assert.equal('threads' in result, false);
  assert.deepEqual(result.files.map((file: any) => file.trackedChanges.map((change: any) => change.id)), [['insert'], ['change-insert-0']]);
  const file = await query('get_review', { projectId, path: docs[0], trackedChanges: {} });
  assert.equal(file.files[0].trackedChanges.length, 2);
  assert.equal('comments' in file.files[0], false);
});

test('label filters combine exact versions and name substrings', async t => {
  const { backend, query } = await setup(t);
  const labels = [{ version: 0, comment: 'Draft' }, { version: 1, comment: 'FINAL draft' }, { version: 1, comment: 'Supplement' }];
  backend.request = async path => {
    assert.equal(path, `/project/${projectId}/labels`);
    return labels;
  };
  assert.deepEqual((await query('list_history_labels', { projectId })).labels, labels);
  assert.deepEqual((await query('list_history_labels', { projectId, version: 1, query: 'draft' })).labels, [labels[1]]);
  assert.deepEqual((await query('list_history_labels', { projectId, version: 0 })).labels, [labels[0]]);
});
