import assert from 'node:assert/strict';
import { OverleafClient } from '../dist/client.js';
import { compileProject } from '../dist/compile.js';
const client = await OverleafClient.connect();
try {
  const result = await compileProject(client, { projectId: process.argv[2], mode: 'local' });
  console.log(JSON.stringify(result));
  assert.equal(result.status, 'success');
} finally { await client.close(); }
