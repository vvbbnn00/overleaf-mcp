// Drop our own reader's socket transport, never the user's editor connection.
import { OverleafClient } from '../dist/client.js';

const [projectId, path = 'main.tex'] = process.argv.slice(2);
if (!projectId) throw new Error('Usage: node scripts/reconnect.mjs <project-id> [file]');
const client = await OverleafClient.connect();
function waitFor(predicate, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const listener = event => {
      if (predicate(event)) { clearTimeout(timer); client.off('change', listener); resolve(event); }
    };
    const timer = setTimeout(() => { client.off('change', listener); reject(new Error('Timed out waiting for connection state')); }, timeout);
    client.on('change', listener);
  });
}
try {
  const initial = await client.watchFile(projectId, path);
  const disconnected = waitFor(e => e.live === false, 15000);
  const restored = waitFor(e => e.live === true);
  const page = client.context.pages().find(p => new URL(p.url()).pathname === `/project/${projectId}`);
  await page.evaluate(() => {
    const socket = window.__overleafMcp.socket;
    const transport = socket.io?.engine?.transport ?? socket.socket?.transport;
    if (!transport) throw new Error('Socket transport not available');
    transport.close();
  });
  await disconnected;
  let rejected = false;
  try { await client.readFile(projectId, path); } catch { rejected = true; }
  if (!rejected) throw new Error('Offline read incorrectly returned live content');
  console.log(JSON.stringify({ check: 'offline-read-rejected', passed: true }));
  const after = await restored;
  console.log(JSON.stringify({ check: 'reconnected', live: after.live, initialVersion: initial.version, restoredVersion: after.version, contentMatches: initial.content === after.content }));
} finally { await client.close(); }
