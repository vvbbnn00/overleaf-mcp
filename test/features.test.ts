import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textEditOperation, replaceExact } from '../src/model.js';
import { submitDocumentEdit } from '../src/live-bridge.js';
import { archivePath } from '../src/zip.js';
import { documentReview } from '../src/review.js';
import { compileProject } from '../src/compile.js';
import { OverleafClient } from '../src/client.js';

test('modern writes preserve Unicode while legacy inserts and ambiguous replacements are rejected', () => {
  const before = 'ab😀c';
  const [operation] = textEditOperation(before, 'ab中c', 'history-ot') as { textOperation: (string | number)[] }[];
  let cursor = 0, output = '';
  for (const component of operation.textOperation) {
    if (typeof component === 'string') output += component;
    else if (component > 0) { output += before.slice(cursor, cursor + component); cursor += component; }
    else cursor -= component;
  }
  assert.equal(cursor, before.length);
  assert.equal(output, 'ab中c');
  assert.throws(() => textEditOperation('', '😀', 'sharejs-text-ot'), /UNSUPPORTED_CHARACTER/);
  assert.equal(replaceExact('a\n中文\nz', '中文', '新内容'), 'a\n新内容\nz');
  assert.throws(() => replaceExact('aaa', 'aa', 'b'), /more than once/);
});

test('separate text edits do not delete the unchanged middle and its comment anchors', () => {
  const before = 'left old\nKEEP_COMMENT_ANCHOR\nright old';
  const after = 'left new\nKEEP_COMMENT_ANCHOR\nright new';
  const ops = textEditOperation(before, after, 'sharejs-text-ot') as any[];
  assert.ok(ops.every(op => !op.d?.includes('KEEP_COMMENT_ANCHOR')));
  let actual = before;
  for (const op of ops) {
    if ('d' in op) { assert.equal(actual.slice(op.p, op.p + op.d.length), op.d); actual = actual.slice(0, op.p) + actual.slice(op.p + op.d.length); }
    else actual = actual.slice(0, op.p) + op.i + actual.slice(op.p);
  }
  assert.equal(actual, after);
});

test('an already canceled compile does not start network or compiler work', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const backend = { compileRemote: async () => { called = true; return { status: 'success' }; } };
  await assert.rejects(compileProject(backend as any, { projectId: 'p', mode: 'remote', signal: controller.signal }), /abort/i);
  assert.equal(called, false);
});

test('queue acknowledgment is not mistaken for applied acknowledgment', async () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  let submitted = false;
  const bridge = {
    connected: true, publicId: 'reader', generation: 1,
    socket: { on: (event: string, fn: (...args: any[]) => void) => handlers.set(event, fn), removeListener: (event: string) => handlers.delete(event) },
    rpc: async (event: string) => {
      if (event === 'joinDoc') return [[], 4, [], {}, 'sharejs-text-ot'];
      submitted = true;
      return [];
    },
  };
  (globalThis as any).window = { __overleafMcp: bridge };
  let resolved = false;
  const pending = submitDocumentEdit({ docId: 'doc', version: 4, type: 'sharejs-text-ot', op: [{ p: 0, i: 'new' }] }).then(value => { resolved = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submitted, true);
  assert.equal(resolved, false);
  handlers.get('otUpdateApplied')!({ doc: 'doc', v: 3 });
  assert.equal(resolved, false);
  handlers.get('otUpdateApplied')!({ doc: 'doc', v: 4, op: [{ i: 'other', p: 0 }], meta: { source: 'collaborator' } });
  assert.equal(resolved, false);
  handlers.get('otUpdateApplied')!({ doc: 'doc', v: 5 });
  assert.deepEqual(await pending, { acceptedVersion: 6, concurrentChanges: true });
  assert.equal(handlers.size, 0);
  submitted = false;
  await assert.rejects(submitDocumentEdit({ docId: 'doc', version: 3, type: 'sharejs-text-ot', op: [] }), /VERSION_CONFLICT/);
  assert.equal(submitted, false);
});

test('an uncertain write cannot be followed by another write on the same connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let submissions = 0;
  const handlers = new Map<string, (...args: any[]) => void>();
  const bridge = {
    connected: true, publicId: 'reader', generation: 1,
    socket: { on: (event: string, fn: (...args: any[]) => void) => handlers.set(event, fn), removeListener: (event: string) => handlers.delete(event) },
    rpc: async (event: string) => event === 'joinDoc' ? [[], 4, [], {}, 'sharejs-text-ot'] : (++submissions, []),
  };
  (globalThis as any).window = { __overleafMcp: bridge };
  const input = { docId: 'doc', version: 4, type: 'sharejs-text-ot', op: [{ p: 0, i: 'new' }] };
  const first = assert.rejects(submitDocumentEdit(input), /WRITE_STATUS_UNKNOWN/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20001);
  await first;
  const second = submitDocumentEdit(input);
  const rejection = assert.rejects(second, /previous write/i);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20001);
  await rejection;
  assert.equal(submissions, 1);
});

test('archive extraction paths cannot escape the output directory', () => {
  for (const name of ['../secret', 'a/../../secret', '/etc/passwd', 'C:/secret', 'a\\b', '\0']) assert.throws(() => archivePath('/tmp/project', name), /Unsafe/);
  assert.equal(archivePath('/tmp/project', '章节/一.tex'), '/tmp/project/章节/一.tex');
});

test('review anchors and tracked deletions retain their source meaning', () => {
  const content = 'first\n中文 last';
  const encoded = Buffer.from('中文').toString('latin1');
  const legacy = documentReview('main.tex', { docId: 'd', version: 2, content, type: 'sharejs-text-ot', ranges: { comments: [{ id: 't', op: { p: 6, c: encoded } }], changes: [{ id: 'c', op: { p: 6, d: encoded } }] } });
  assert.deepEqual(legacy.comments[0].ranges[0].start, { offset: 6, line: 2, column: 1 });
  assert.equal(legacy.comments[0].ranges[0].text, '中文');
  assert.equal(legacy.trackedChanges[0].kind, 'delete');
  assert.deepEqual(legacy.trackedChanges[0].start, legacy.trackedChanges[0].end);
  const modern = documentReview('main.tex', { docId: 'd', version: 3, content, type: 'history-ot', reviewComments: [{ id: 't', ranges: [{ pos: 6, length: 2 }], resolved: false }], reviewChanges: [{ range: { pos: 6, length: 2 }, tracking: { type: 'delete', userId: 'u' } }] });
  assert.equal(modern.trackedChanges[0].text, '中文');
  assert.equal(modern.trackedChanges[0].end?.column, 3);
});

test('auto compilation reports syntax errors without starting a local build', async () => {
  const result = await compileProject({ compileRemote: async () => ({ status: 'compile-error' }) } as any, { projectId: 'p', mode: 'auto' });
  assert.equal(result.status, 'compile-error');
});

test('project pagination collects every page and detects a non-progressing server', async () => {
  const client = Reflect.construct(OverleafClient, [{}, {}, {}]) as OverleafClient;
  let calls = 0;
  client.request = async (_path, _method, body: any) => {
    calls++;
    return body.page.lastId ? { totalSize: 3, projects: [{ id: '3' }] } : { totalSize: 3, projects: [{ id: '1' }, { id: '2' }] };
  };
  const result = await client.listProjects();
  assert.equal(result.projects.length, 3);
  assert.equal(calls, 2);
  client.request = async () => ({ totalSize: 3, projects: [{ id: '1' }] });
  await assert.rejects(client.listProjects(), /no progress/);
});
