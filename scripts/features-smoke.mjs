import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OverleafClient } from '../dist/client.js';

const projectId = process.argv[2];
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'serve'], cwd: process.cwd(), stderr: 'inherit' });
const client = new Client({ name: 'overleaf-feature-acceptance', version: '1' });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return result.structuredContent;
};
const log = (check, value) => console.log(JSON.stringify({ check, ...value }));
let docId;
try {
  await client.connect(transport);
  assert.equal((await call('get_project', { projectId })).name, 'TestForMCP');
  const initial = await call('read_file', { projectId, path: 'main.tex' });
  const projects = await call('list_projects');
  assert.equal(projects.projects.length, projects.totalSize);
  log('project-list', { complete: projects.complete, count: projects.totalSize });
  const review = await call('get_review', { projectId, path: 'main.tex' });
  assert.equal(review.complete, true);
  assert.ok(review.files[0].comments.length > 0);
  const comment = review.files[0].comments[0];
  assert.ok(review.threads[comment.threadId]);
  log('review-anchors', { line: comment.ranges[0].start.line, column: comment.ranges[0].start.column, trackedChanges: review.files[0].trackedChanges.length });
  const image = await call('download_file', { projectId, path: 'frog.jpg' });
  const imageResource = await client.readResource({ uri: image.artifact.resourceUri });
  assert.equal(Buffer.from(imageResource.contents[0].blob, 'base64')[0], 0xff);
  const zip = await call('download_project', { projectId });
  log('downloads', { imageMime: image.artifact.mimeType, zipBytes: zip.artifact.size });
  const history = await call('list_history', { projectId });
  const latest = history.updates[0].toV;
  await call('list_history_labels', { projectId });
  const diff = await call('get_history_diff', { projectId, from: 0, to: latest, path: 'main.tex' });
  await call('get_history_diff', { projectId, from: 0, to: latest });
  const old = await call('download_project', { projectId, historyVersion: 0 });
  log('history', { comparedTo: latest, diffKeys: Object.keys(diff), initialVersionZipBytes: old.artifact.size });
  const path = `mcp-acceptance-${randomUUID().slice(0, 8)}.tex`;
  const created = await call('create_file', { projectId, name: path });
  docId = created._id;
  const empty = await call('read_file', { projectId, path });
  const content = '% 中文写入测试\n\\documentclass{article}\n\\begin{document}MCP smoke\\end{document}\n';
  const written = await call('write_file', { projectId, path, expectedDocId: docId, expectedVersion: empty.version, content });
  assert.equal(written.content, content);
  const patched = await call('replace_text', { projectId, path, expectedDocId: docId, expectedVersion: written.version, oldText: 'MCP smoke', newText: 'MCP verified' });
  assert.equal(patched.matchesRequestedContent, true);
  const stale = await client.callTool({ name: 'write_file', arguments: { projectId, path, expectedDocId: docId, expectedVersion: empty.version, content: 'stale' } });
  assert.equal(stale.isError, true);
  log('writes', { created: true, version: patched.version, staleWriteRejected: true });
  for (const mode of ['remote', 'local']) {
    const started = await call('compile_project', { projectId, rootPath: path, mode });
    let job;
    const deadline = Date.now() + 180000;
    do {
      if (Date.now() > deadline) throw new Error('Compile job did not finish');
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await call('get_compile_result', { jobId: started.jobId });
    } while (job.state === 'running');
    assert.equal(job.state, 'completed', job.error);
    assert.equal(job.result.status, 'success');
    const pdf = job.result.outputs.find(file => file.mimeType === 'application/pdf');
    const resource = await client.readResource({ uri: pdf.resourceUri });
    assert.equal(Buffer.from(resource.contents[0].blob, 'base64').subarray(0, 5).toString(), '%PDF-');
    log('compile-job', { mode, status: job.result.status, bytes: pdf.size, artifactPath: pdf.localPath });
  }
  assert.equal((await call('read_file', { projectId, path: 'main.tex' })).content, initial.content);
  log('existing-source-preserved', { passed: true });
} finally {
  await client.close();
  if (docId) {
    const cleanup = await OverleafClient.connect();
    try { await cleanup.request(`/project/${projectId}/doc/${docId}`, 'DELETE'); }
    finally { await cleanup.close(); }
  }
}
