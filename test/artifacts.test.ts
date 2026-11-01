import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'overleaf-artifacts-test-'));
process.env.OVERLEAF_STATE_DIR = directory;
const { saveArtifact, readArtifact } = await import('../src/artifacts.js');
after(() => rm(directory, { recursive: true, force: true }));

test('a file named metadata.json cannot overwrite its artifact manifest', async () => {
  const content = Buffer.from('{"source":true}');
  const artifact = await saveArtifact('metadata.json', content, 'application/json');
  const result = await readArtifact(artifact.resourceUri);
  assert.deepEqual(result.bytes, content);
  assert.equal(result.info.sha256, artifact.sha256);
});
