import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { safeErrorMessage } from '../src/errors.js';
import { probeSession } from '../src/session.js';
import { OverleafClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';

const marker = 'synthetic-cookie-not-a-credential';
const error = new Error(`apiRequestContext.get: Request timed out\nCall log:\n  - cookie: test_session=${marker}\n  - x-csrf-token: ${marker}`);
const safe = (value: unknown) => {
  const message = value instanceof Error ? value.message : String(value);
  assert.match(message, /timed out/);
  assert.ok(!message.includes(marker));
  assert.ok(!message.includes('Call log:'));
  return true;
};

test('error summaries omit request logs and sensitive URL/header values', () => {
  safe(safeErrorMessage(error));
  assert.equal(safeErrorMessage(new Error(`cookie: ${marker}`)), 'cookie: [redacted]');
  assert.equal(safeErrorMessage(new Error(`Failed at https://example.invalid/share#${marker}`)), 'Failed at [URL redacted]');
});

test('session and download errors do not propagate HTTP cookie logs', async () => {
  const context = { cookies: async () => [], request: { get: async () => { throw error; } } };
  await assert.rejects(probeSession(context as any), safe);
  const client = Reflect.construct(OverleafClient, [{}, context, {}]) as OverleafClient;
  await assert.rejects(client.downloadBytes('/project/file'), safe);
});

test('MCP tool, resource and subscription failures redact request diagnostics', async () => {
  const host = createMcpServer(async () => { throw error; });
  const client = new Client({ name: 'redaction-test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await host.server.connect(remote); await client.connect(local);
    const result = await client.callTool({ name: 'get_session_status' });
    assert.equal(result.isError, true);
    safe((result.content as any[])[0].text);
    const uri = 'overleaf://projects/0123456789abcdef01234567/files/main.tex';
    await assert.rejects(client.readResource({ uri }), safe);
    await assert.rejects(client.subscribeResource({ uri }), safe);
  } finally { await client.close(); await host.close(); }
});
