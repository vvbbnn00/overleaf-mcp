import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OverleafClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';
import { AuthenticationError } from '../src/session.js';
import { commentOperation, documentReview, trackedChangePlan } from '../src/review.js';

const projectId = '0123456789abcdef01234567';
const threadId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function backend(options: { postError?: Error; refreshError?: Error } = {}) {
  const client = Reflect.construct(OverleafClient, [{ close: async () => {} }, {}, {}]) as OverleafClient;
  const thread = { messages: [{ id: 'original', content: 'Original comment' }] };
  let posts = 0;
  client.request = async (path, method = 'GET', body?: any) => {
    if (method === 'POST') {
      posts++;
      assert.equal(path, `/project/${projectId}/thread/${threadId}/messages`);
      if (options.postError) throw options.postError;
      thread.messages.push({ id: 'reply', content: body.content });
      return;
    }
    assert.equal(path, `/project/${projectId}/threads`);
    if (posts && options.refreshError) throw options.refreshError;
    return { [threadId]: thread };
  };
  return { client, thread, posts: () => posts };
}

test('MCP replies preserve content and cannot create a thread from an unknown ID', async () => {
  const service = backend();
  const host = createMcpServer(async () => service.client);
  const client = new Client({ name: 'review-test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await host.server.connect(remote);
    await client.connect(local);
    const content = '  已修改公式。\nPlease review.  ';
    const reply = await client.callTool({ name: 'reply_to_comment', arguments: { projectId, threadId, content } });
    assert.equal(reply.isError, undefined);
    assert.equal(reply.structuredContent?.posted, true);
    assert.deepEqual((reply.structuredContent?.thread as any).messages, [
      { id: 'original', content: 'Original comment' }, { id: 'reply', content },
    ]);
    const missing = await client.callTool({ name: 'reply_to_comment', arguments: { projectId, threadId: 'bbbbbbbbbbbbbbbbbbbbbbbb', content } });
    assert.equal(missing.isError, true);
    assert.match((missing.content as any[])[0].text, /thread not found/i);
    assert.equal(service.posts(), 1);
  } finally { await client.close(); await host.close(); }
});

test('a failed refresh does not turn a posted reply into a failed write', async () => {
  const service = backend({ refreshError: new Error('Read timed out') });
  try {
    const reply = await service.client.replyToComment(projectId, threadId, 'Reply');
    assert.equal(reply.posted, true);
    assert.equal(reply.thread, null);
    assert.equal('readBackError' in reply && reply.readBackError, 'Read timed out');
    assert.equal(service.posts(), 1);
  } finally { await service.client.close(); }
});

test('replies distinguish rejection from an uncertain submission and never retry the POST', async () => {
  for (const error of [new AuthenticationError('Sign in required'), Object.assign(new Error('Overleaf returned HTTP 403'), { status: 403 }), new Error('Request timed out')]) {
    const service = backend({ postError: error });
    try {
      await assert.rejects(service.client.replyToComment(projectId, threadId, 'Reply'), caught => {
        if (error.message === 'Request timed out') assert.match((caught as Error).message, /REPLY_STATUS_UNKNOWN.*get_review/);
        else assert.equal(caught, error);
        return true;
      });
      assert.equal(service.posts(), 1);
    } finally { await service.client.close(); }
  }
});

test('legacy rejection restores adjacent Unicode changes and marks restored deletions as undo operations', () => {
  const encoded = (value: string) => Buffer.from(value).toString('latin1');
  const snapshot = { type: 'sharejs-text-ot', content: '前新词后', ranges: { changes: [
    { id: 'insert', op: { p: 1, i: encoded('新词') } },
    { id: 'delete', op: { p: 3, d: encoded('旧词') } },
  ] } };
  const plan = trackedChangePlan(snapshot, ['insert', 'delete'], 'reject');
  let text = snapshot.content;
  for (const op of plan.op as any[]) {
    if ('i' in op) {
      assert.equal(op.u, true, 'Overleaf uses the undo flag to clear the restored deletion marker');
      text = text.slice(0, op.p) + op.i + text.slice(op.p);
    } else {
      assert.equal(text.slice(op.p, op.p + op.d.length), op.d);
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
    }
  }
  assert.equal(text, '前旧词后');
  assert.equal(plan.expectedContent, text);
  assert.throws(() => commentOperation({ ...snapshot, content: '😀' }, '😀', threadId), /UNSUPPORTED_CHARACTER/);
});

test('modern review decisions preserve other tracked ranges and use snapshot Unicode offsets', () => {
  const snapshot = { type: 'history-ot', content: '😀NEWoldKEEPz', reviewChanges: [
    { range: { pos: 2, length: 3 }, tracking: { type: 'insert' } },
    { range: { pos: 5, length: 3 }, tracking: { type: 'delete' } },
    { range: { pos: 8, length: 4 }, tracking: { type: 'insert' } },
  ] };
  const ids = documentReview('main.tex', snapshot).trackedChanges.slice(0, 2).map(change => change.id);
  for (const action of ['accept', 'reject'] as const) {
    const plan = trackedChangePlan(snapshot, ids, action);
    const marks = Array.from({ length: snapshot.content.length }, (_, i) => i >= 8 && i < 12 ? 'keep' : i >= 2 && i < 8 ? 'selected' : '');
    let cursor = 0, result = '';
    const resultMarks: string[] = [];
    for (const op of (plan.op[0] as any).textOperation) {
      if (typeof op === 'number' && op < 0) { cursor -= op; continue; }
      const length = typeof op === 'number' ? op : op.r;
      result += snapshot.content.slice(cursor, cursor + length);
      resultMarks.push(...(typeof op === 'object' && op.tracking?.type === 'none' ? Array(length).fill('') : marks.slice(cursor, cursor + length)));
      cursor += length;
    }
    assert.equal(cursor, snapshot.content.length);
    assert.equal(result, action === 'accept' ? '😀NEWKEEPz' : '😀oldKEEPz');
    assert.equal(plan.expectedContent, result);
    assert.equal(resultMarks.filter(mark => mark === 'keep').length, 4);
    assert.equal(resultMarks.filter(mark => mark === 'selected').length, 0);
  }
  assert.deepEqual(commentOperation(snapshot, 'KEEP', threadId), [{ commentId: threadId, ranges: [{ pos: 8, length: 4 }] }]);
});

function documentBackend() {
  const service = backend();
  const snapshot = { docId: 'cccccccccccccccccccccccc', version: 2, type: 'sharejs-text-ot', content: 'Passage', ranges: { comments: [], changes: [] } };
  service.client.getProject = async () => ({ id: projectId, name: 'Review', files: [{ id: snapshot.docId, path: 'main.tex', kind: 'doc' }] });
  const page = { evaluate: async () => snapshot };
  (service.client as any).project = async () => ({ page });
  return { ...service, snapshot, page };
}

test('stale document identities and versions are checked before review mutations', async () => {
  const service = documentBackend();
  await assert.rejects(service.client.createComment(projectId, 'main.tex', service.snapshot.docId, 1, 'Passage', 'Comment'), /VERSION_CONFLICT/);
  await assert.rejects(service.client.decideTrackedChanges(projectId, 'main.tex', 'dddddddddddddddddddddddd', 2, ['change'], 'reject'), /VERSION_CONFLICT/);
  assert.equal(service.posts(), 0);
});

test('thread deletion checks the source location before sending the mutation', async () => {
  const service = documentBackend();
  service.client.getReview = async () => ({ projectId, complete: true, unavailable: [], observedAt: '', threads: {}, files: [{ path: 'other.tex', comments: [{ threadId }] }] } as any);
  await assert.rejects(service.client.changeCommentThread(projectId, 'main.tex', threadId, 'delete'), /other\.tex/);
  assert.equal(service.posts(), 0);
});

test('comment creation reports its posted thread when attaching the source range needs a fresh version', async () => {
  const service = documentBackend();
  let postedId = '';
  service.client.request = async path => { postedId = path.split('/')[4]; };
  service.page.evaluate = async (fn?: unknown) => {
    if ((fn as Function).name === 'submitDocumentEdit') throw new Error('VERSION_CONFLICT');
    return service.snapshot;
  };
  const result = await service.client.createComment(projectId, 'main.tex', service.snapshot.docId, 2, 'Passage', 'Comment');
  assert.equal(result.posted, true);
  assert.equal(result.anchored, null);
  assert.equal(result.threadId, postedId);
  service.client.request = async path => { postedId = path.split('/')[4]; throw new Error('Request timed out'); };
  await assert.rejects(service.client.createComment(projectId, 'main.tex', service.snapshot.docId, 2, 'Passage', 'Comment'), error => {
    assert.ok((error as Error).message.includes(postedId));
    assert.match((error as Error).message, /REVIEW_STATUS_UNKNOWN/);
    return true;
  });
});

test('message deletion uses author permissions for own replies and project permissions for other messages', async () => {
  const messageId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  for (const author of ['current-user', 'collaborator']) {
    const client = Reflect.construct(OverleafClient, [{ close: async () => {} }, {}, { evaluate: async () => 'current-user' }]) as OverleafClient;
    let deleted = false;
    client.request = async (path, method = 'GET') => {
      if (method === 'DELETE') {
        assert.equal(path, `/project/${projectId}/thread/${threadId}/${author === 'current-user' ? 'own-messages' : 'messages'}/${messageId}`);
        deleted = true;
      }
      return { [threadId]: { messages: deleted ? [] : [{ id: messageId, user_id: author }] } };
    };
    assert.equal((await client.deleteCommentMessage(projectId, threadId, messageId)).verified, true);
    await client.close();
  }
});
