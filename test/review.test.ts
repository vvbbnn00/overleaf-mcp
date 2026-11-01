import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OverleafClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';
import { AuthenticationError } from '../src/session.js';

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
