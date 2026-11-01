import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OverleafClient } from '../dist/client.js';

const [projectId, path = 'main.tex'] = process.argv.slice(2);
if (!projectId) throw new Error('Usage: node scripts/reader-safety.mjs <project-id> [file]');
const client = await OverleafClient.connect();
const scripts = new Set();
const compileRequests = [];
client.context.on('response', response => {
  if (response.request().resourceType() === 'script' && response.ok()) scripts.add(new URL(response.url()).pathname);
});
client.context.on('request', request => {
  if (/\/compile(?:[/?]|$)/.test(new URL(request.url()).pathname)) compileRequests.push(request.method());
});
try {
  const file = await client.readFile(projectId, path);
  assert.equal(file.live, true);
  assert.ok(scripts.size > 0);
  assert.ok([...scripts].every(path => path.endsWith('/socket.io/socket.io.js')));
  assert.deepEqual(compileRequests, []);
  console.log(JSON.stringify({ live: file.live, version: file.version, loadedScriptPaths: [...scripts], compileRequests: compileRequests.length, sha256: createHash('sha256').update(file.content).digest('hex') }));
} finally { await client.close(); }
