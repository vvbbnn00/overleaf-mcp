import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OverleafClient } from '../dist/client.js';
const projectId = process.argv[2];
const client = await OverleafClient.connect();
let docId;
try {
  assert.equal((await client.getProject(projectId)).name, 'TestForMCP', 'Writes are restricted to the authorized test project');
  const name = `mcp-write-${randomUUID().slice(0, 8)}.tex`;
  const created = await client.createFile(projectId, name);
  docId = created._id;
  assert.ok(docId, `Unexpected create response keys: ${Object.keys(created)}`);
  const empty = await client.readFile(projectId, name);
  await assert.rejects(client.writeFile(projectId, name, empty.docId, empty.version, { content: '😀' }), /UNSUPPORTED_CHARACTER/);
  const content = '% MCP 中文\n\\documentclass{article}\n\\begin{document}Test\\end{document}\n';
  const written = await client.writeFile(projectId, name, empty.docId, empty.version, { content });
  assert.equal(written.applied, true);
  assert.equal(written.content, content);
  console.log(JSON.stringify({ check: 'write', version: written.version, verified: written.verified, unicodePreserved: true }));
  await assert.rejects(client.writeFile(projectId, name, empty.docId, empty.version, { content: 'stale overwrite' }), /VERSION_CONFLICT/);
  const patched = await client.writeFile(projectId, name, written.docId, written.version, { oldText: 'Test', newText: 'Edited 中文' });
  assert.equal(patched.content, content.replace('Test', 'Edited 中文'));
  console.log(JSON.stringify({ check: 'patch-and-conflict', passed: true, version: patched.version }));
} finally {
  if (docId) await client.request(`/project/${projectId}/doc/${docId}`, 'DELETE');
  await client.close();
}
