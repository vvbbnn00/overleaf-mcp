import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'overleaf-download-test-'));
process.env.OVERLEAF_STATE_DIR = directory;
const { OverleafClient } = await import('../src/client.js');
after(() => rm(directory, { recursive: true, force: true }));

test('a normal download redirect is followed without reporting an expired login', async () => {
  const visited: string[] = [];
  const context = {
    storageState: async () => ({ cookies: [], origins: [] }),
    request: { get: async (url: string) => {
      visited.push(url);
      const first = visited.length === 1;
      return { status: () => first ? 302 : 200, ok: () => !first, headers: () => first ? { location: '/project/file-final' } : { 'content-type': 'application/octet-stream' }, body: async () => Buffer.from('file'), dispose: async () => {} };
    } },
  };
  const client = Reflect.construct(OverleafClient, [{}, context, {}]);
  assert.equal((await client.downloadBytes('/project/file')).bytes.toString(), 'file');
  assert.equal(visited.length, 2);
});

test('an HTML attachment is downloadable without accepting a login page as an image', async () => {
  const context = {
    storageState: async () => ({ cookies: [], origins: [] }),
    request: { get: async () => ({ status: () => 200, ok: () => true, headers: () => ({ 'content-type': 'text/html' }), body: async () => Buffer.from('<p>project attachment</p>'), dispose: async () => {} }) },
  };
  const client = Reflect.construct(OverleafClient, [{}, context, {}]);
  client.getProject = async () => ({ files: [{ id: 'file', path: 'appendix.html', kind: 'file' }] });
  const result = await client.downloadFile('0123456789abcdef01234567', 'appendix.html');
  assert.equal(await readFile(result.artifact.localPath, 'utf8'), '<p>project attachment</p>');
  await assert.rejects(client.downloadBytes('/project/image'), /HTML page/);
});
