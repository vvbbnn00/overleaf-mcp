import assert from 'node:assert/strict';
import { OverleafClient } from '../dist/client.js';
const projectId = process.argv[2];
const client = await OverleafClient.connect();
try {
  const zip = await client.downloadProject(projectId);
  console.log(JSON.stringify({ check: 'project-zip', size: zip.artifact.size, path: zip.artifact.localPath }));
  const image = await client.downloadFile(projectId, 'frog.jpg');
  assert.ok(image.artifact.size > 0);
  console.log(JSON.stringify({ check: 'attachment', mime: image.artifact.mimeType, size: image.artifact.size }));
  const result = await client.compileRemote(projectId);
  console.log(JSON.stringify({ check: 'compile', ...result }));
  assert.equal(result.status, 'success');
  assert.ok(result.outputs.some(output => output.filename === 'output.pdf' && output.size > 0));
  const labels = await client.historyLabels(projectId);
  const history = await client.history(projectId);
  console.log(JSON.stringify({ check: 'history', labels: labels.labels.length, updates: history.updates.map(update => ({ fromV: update.fromV, toV: update.toV })) }));
  const update = history.updates.find(update => Number.isInteger(update.toV));
  if (update) {
    const diff = await client.historyDiff(projectId, update.fromV, update.toV, 'main.tex');
    const version = await client.downloadProject(projectId, update.toV);
    console.log(JSON.stringify({ check: 'version-diff-download', version: update.toV, diffKeys: Object.keys(diff), zipSize: version.artifact.size }));
  }
} finally { await client.close(); }
