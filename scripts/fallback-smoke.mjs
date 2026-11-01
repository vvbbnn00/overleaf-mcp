import assert from 'node:assert/strict';
import { OverleafClient } from '../dist/client.js';
import { compileProject } from '../dist/compile.js';
const client = await OverleafClient.connect();
try {
  // Inject only the remote timeout; download and local TeX execution are real.
  client.compileRemote = async () => ({ status: 'timedout', mode: 'remote' });
  const result = await compileProject(client, { projectId: process.argv[2], mode: 'auto' });
  assert.equal(result.mode, 'local');
  assert.equal(result.status, 'success');
  assert.equal(result.fallbackFrom.status, 'timedout');
  console.log(JSON.stringify({ simulatedRemoteTimeout: true, actualLocalCompile: result.status, isolation: result.isolation }));
} finally { await client.close(); }
