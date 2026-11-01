// Read-only acceptance check through the actual MCP stdio protocol.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';

const projectId = process.argv[2];
const path = process.argv[3] ?? 'main.tex';
if (!projectId) throw new Error('Usage: node scripts/smoke.mjs <project-id> [file]');
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'serve'], cwd: process.cwd(), stderr: 'inherit' });
const client = new Client({ name: 'overleaf-mcp-acceptance', version: '0.1.0' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(JSON.stringify({ check: 'tools', names: tools.tools.map(t => t.name) }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  const session = await call('get_session_status');
  console.log(JSON.stringify({ check: 'session', authenticated: session.authenticated, rollingExpiryObserved: session.rollingExpiryObserved, nextKeepaliveAt: session.nextKeepaliveAt }));
  const project = await call('get_project', { projectId });
  console.log(JSON.stringify({ check: 'project', name: project.name, files: project.files.map(f => f.path) }));
  const file = await call('read_file', { projectId, path });
  console.log(JSON.stringify({ check: 'file', path, version: file.version, live: file.live, chars: file.content.length, sha256: createHash('sha256').update(file.content).digest('hex') }));
  const range = await call('read_file', { projectId, path, startLine: 1, endLine: 3 });
  if (range.content !== file.content.split('\n').slice(0, 3).join('\n')) throw new Error('Line range mismatch (or concurrent edit)');
  const resource = await client.readResource({ uri: file.resourceUri });
  if (resource.contents[0].text !== file.content) throw new Error('Resource mismatch (or concurrent edit)');
  console.log(JSON.stringify({ check: 'line-range-and-resource', passed: true }));
  const watch = await call('watch_file', { projectId, path });
  await client.subscribeResource({ uri: watch.resourceUri });
  console.log(JSON.stringify({ check: 'resource-subscription', passed: true }));
  const timeout = await call('wait_for_file_change', { projectId, path, afterVersion: watch.version, timeoutSeconds: 1 });
  console.log(JSON.stringify({ check: 'wait', changed: timeout.changed, version: timeout.version }));
  await client.unsubscribeResource({ uri: watch.resourceUri });
  await call('unwatch_file', { watchId: watch.watchId });
  const history = await call('list_history', { projectId });
  console.log(JSON.stringify({ check: 'history', responseKeys: Object.keys(history), updatesCount: history.updates?.length }));
  const collaboration = await call('get_collaboration', { projectId });
  console.log(JSON.stringify({ check: 'collaboration', invitedMemberCount: collaboration.invitedMembers.length, presenceStatus: collaboration.presence.status, onlineAccounts: collaboration.presence.users?.length }));
  const review = await call('get_review', { projectId });
  const threads = Object.values(review.threads);
  console.log(JSON.stringify({ check: 'review', threadCount: threads.length, resolvedCount: threads.filter(thread => thread.resolved).length, testCommentPresent: JSON.stringify(review.threads).includes('MCP 评论测试') }));
} finally { await client.close(); }
