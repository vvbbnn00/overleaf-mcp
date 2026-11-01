// Interactive acceptance through MCP. Prints summaries, not credentials or emails.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';

const [projectId, path = 'main.tex'] = process.argv.slice(2);
if (!projectId) throw new Error('Usage: node scripts/collaboration-mcp.mjs <project-id> [file]');
const transport = new StdioClientTransport({
  command: process.execPath, args: ['dist/cli.js', 'serve'], cwd: process.cwd(), stderr: 'inherit',
  env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith('OVERLEAF_') && value !== undefined)),
});
const client = new Client({ name: 'overleaf-collaboration-acceptance', version: '0.1.0' });
const call = async (name, args = { projectId }) => {
  const value = await client.callTool({ name, arguments: args });
  if (value.isError) throw new Error(value.content[0].text);
  return value.structuredContent ?? JSON.parse(value.content[0].text);
};
const output = (check, data) => console.log(JSON.stringify({ check, ...data, observedAt: new Date().toISOString() }));
let latestVersion;
let previousStatus;
let previousReview;
let timer;
let busy = false;
let pendingFile = Promise.resolve();
const readFile = () => {
  pendingFile = pendingFile.then(async () => {
    const file = await call('read_file', { projectId, path });
    if (file.version === latestVersion) return;
    latestVersion = file.version;
    output('file', { version: file.version, live: file.live, chars: file.content.length, collaboratorMarker: file.content.includes('MCP 协作者测试'), sha256: createHash('sha256').update(file.content).digest('hex') });
  }).catch(error => output('file-error', { error: error.message }));
  return pendingFile;
};
const status = async () => {
  if (busy) return;
  busy = true;
  try {
    const collaboration = await call('get_collaboration');
    const members = collaboration.invitedMembers ?? [];
    const users = collaboration.presence.users ?? [];
    const summary = {
      members: members.map(member => ({ role: member.privilegeLevel ?? member.privileges, userId: member.user?._id ?? member._id })),
      presenceStatus: collaboration.presence.status,
      onlineAccounts: users.length,
      otherOnlineAccounts: users.filter(user => !user.isCurrentUser).length,
    };
    const key = JSON.stringify(summary);
    if (key !== previousStatus) {
      previousStatus = key;
      output('collaboration', { invitedMemberCount: members.length, roles: summary.members.map(member => member.role), presenceStatus: summary.presenceStatus, onlineAccounts: summary.onlineAccounts, otherOnlineAccounts: summary.otherOnlineAccounts });
    }
    const review = await call('get_review');
    const threads = Object.values(review.threads ?? {});
    const reviewKey = JSON.stringify(review.threads);
    if (reviewKey !== previousReview) {
      previousReview = reviewKey;
      output('review', { threadCount: threads.length, resolvedCount: threads.filter(t => t.resolved).length, messageCount: threads.reduce((n, t) => n + (t.messages?.length ?? 0), 0), testCommentPresent: reviewKey.includes('MCP 评论测试') });
    }
  } catch (error) { output('status-error', { error: error.message }); }
  finally { busy = false; }
};
try {
  await client.connect(transport);
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => {
    output('resource-notification', { received: true });
    void readFile();
  });
  const watch = await call('watch_file', { projectId, path });
  await client.subscribeResource({ uri: watch.resourceUri });
  await readFile();
  await status();
  output('ready', { watching: path });
  timer = setInterval(() => void status(), 10000);
  await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  clearInterval(timer);
  await client.unsubscribeResource({ uri: watch.resourceUri });
  await call('unwatch_file', { watchId: watch.watchId });
} finally { clearInterval(timer); await client.close(); }
