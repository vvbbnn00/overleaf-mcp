import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverleafClient } from '../src/client.js';
import { selectLines } from '../src/model.js';

const projectId = '0123456789abcdef01234567';
const path = 'main.tex';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function reader() {
  const client = Reflect.construct(OverleafClient, [{ close: async () => {} }, {}, {}]) as OverleafClient;
  client.getProject = async () => ({ id: projectId, name: 'test', files: [{ id: 'doc', path, kind: 'doc' }] });
  return client;
}
const snapshot = { projectId, path, docId: 'doc', content: 'current', version: 1, live: true };

test('simultaneous watches share initialization and both return a complete snapshot', async () => {
  const client = reader();
  const gate = deferred<any>();
  let reads = 0;
  client.readFile = async () => { reads++; return gate.promise; };
  const first = client.watchFile(projectId, path);
  const second = client.watchFile(projectId, path);
  await tick();
  gate.resolve(snapshot);
  const values = await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.ok(values.every(value => value.live && value.version === 1));
  await client.close();
});

test('unwatch prevents an in-flight refresh from publishing after cancellation', async () => {
  const client = reader();
  const gate = deferred<any>();
  client.readFile = async () => gate.promise;
  const changes: unknown[] = [];
  client.on('change', event => changes.push(event));
  const pending = client.watchFile(projectId, path);
  await tick();
  assert.equal(client.unwatchFile(`${projectId}:${path}`), true);
  gate.resolve(snapshot);
  await pending.catch(() => {});
  assert.equal(changes.length, 0);
  await client.close();
});

test('concurrent reads after a tree change replace the project connection once', async () => {
  const client = Reflect.construct(OverleafClient, [{ close: async () => {} }, {}, {}]) as any;
  const closeGate = deferred<void>();
  let opened = 0;
  let closed = 0;
  const data = { id: projectId, name: 'test', rootFolder: [{ docs: [], folders: [], fileRefs: [] }] };
  const old = { dirtyTree: false, page: { isClosed: () => false, evaluate: async () => data, close: async () => { closed++; await closeGate.promise; } } };
  client.openProject = async () => { opened++; return opened === 1 ? old : { dirtyTree: false, page: { isClosed: () => false, evaluate: async () => data, close: async () => {} } }; };
  await client.getProject(projectId);
  old.dirtyTree = true;
  const first = client.getProject(projectId);
  const second = client.getProject(projectId);
  await tick();
  closeGate.resolve();
  await Promise.all([first, second]);
  assert.equal(opened, 2);
  assert.equal(closed, 1);
  await client.close();
});

test('a line range past EOF is rejected instead of returning inverted bounds', () => {
  assert.throws(() => selectLines('one\ntwo', 10, 20), /line range/i);
});

test('write verification does not report success for a replacement document at the same path', async () => {
  const client = reader() as any;
  client.reviewSnapshot = async () => ({
    snapshot: { ...snapshot, docId: 'original', content: 'old', type: 'sharejs-text-ot' },
    page: { evaluate: async () => ({ acceptedVersion: 2, concurrentChanges: false }) },
  });
  client.readFile = async () => ({ ...snapshot, docId: 'replacement', version: 2, content: 'new', type: 'sharejs-text-ot' });
  const result = await client.writeFile(projectId, path, 'original', 1, { content: 'new' });
  assert.equal(result.applied, true);
  assert.equal(result.verified, false);
  await client.close();
});

test('exact replacements keep text edits within the selected passage even when adjacent characters repeat', async () => {
  const client = reader() as any;
  let submitted: any[] = [];
  client.reviewSnapshot = async () => ({
    snapshot: { ...snapshot, content: 'baaa end', type: 'sharejs-text-ot', ranges: { comments: [{ id: 'thread', op: { p: 2, c: 'aa end' } }] } },
    page: { evaluate: async (_run: unknown, input: any) => { submitted = input.op; return { acceptedVersion: 2, concurrentChanges: false }; } },
  });
  client.readFile = async () => ({ ...snapshot, version: 2, content: 'baaaa end' });
  await client.writeFile(projectId, path, 'doc', 1, { oldText: 'ba', newText: 'baa' });
  let text = 'baaa end', boundary = 2;
  for (const op of submitted) {
    if ('d' in op) {
      assert.ok(op.p + op.d.length <= boundary);
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      boundary -= op.d.length;
    } else if ('i' in op) {
      assert.ok(op.p <= boundary);
      text = text.slice(0, op.p) + op.i + text.slice(op.p);
      boundary += op.i.length;
    }
  }
  assert.equal(text, 'baaaa end');
  assert.equal(boundary, 3);
  await client.close();
});

test('retrying a watch after a transient snapshot failure reads fresh content', async () => {
  const client = reader();
  let calls = 0;
  client.readFile = async () => {
    if (++calls === 1) throw new Error('Temporary snapshot timeout');
    return snapshot as any;
  };
  assert.equal((await client.watchFile(projectId, path)).live, false);
  assert.equal((await client.watchFile(projectId, path)).live, true);
  assert.equal(calls, 2);
  await client.close();
});
