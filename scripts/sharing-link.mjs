// Explicit operator action; not exposed as a read-only MCP tool.
import { OverleafClient } from '../dist/client.js';
import { baseUrl } from '../dist/session.js';

const [projectId, action = 'inspect'] = process.argv.slice(2);
if (!/^[a-f\d]{24}$/i.test(projectId ?? '')) throw new Error('Usage: node scripts/sharing-link.mjs <project-id> [inspect|enable]');
if (!['inspect', 'enable'].includes(action)) throw new Error('Unknown action');
const client = await OverleafClient.connect();
try {
  const path = `/project/${projectId}/sharing-link`;
  let existing;
  try {
    existing = await client.request(path);
    console.log(JSON.stringify({ action: 'inspect', available: true, privileges: existing.privileges, restrictedToGroup: Boolean(existing.subscriptionId) }));
  } catch (error) { console.log(JSON.stringify({ action: 'inspect', error: error.message })); }
  if (action === 'enable') {
    const result = existing?.privileges === 'readAndWrite' && !existing.subscriptionId
      ? existing : await client.request(path, 'POST', { privileges: 'readAndWrite' });
    // Don't log the token. URL delivery is separate from diagnostic output.
    console.log(JSON.stringify({ action: 'enable', privileges: result.privileges, tokenReturned: Boolean(result.token) }));
    const validation = await client.request(`/project/${projectId}/share/validate`, 'POST', { token: result.token });
    if (validation.valid !== true) throw new Error('The server did not validate the sharing token');
    const link = `${baseUrl}/project/${projectId}/share#${result.token}`;
    const response = await client.context.request.get(link.split('#')[0]);
    if (!response.ok()) throw new Error('The sharing page is unavailable');
    console.log(JSON.stringify({ action: 'verified-link', link, privileges: result.privileges }));
  }
} finally { await client.close(); }
