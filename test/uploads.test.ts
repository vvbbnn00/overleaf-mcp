import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const directory = await mkdtemp(join(tmpdir(), 'overleaf-uploads-test-'));
process.env.OVERLEAF_STATE_DIR = join(directory, 'state');
const { uploadDestination, loadUpload, uploadedTextMatches } = await import('../src/uploads.js');
const { OverleafClient } = await import('../src/client.js');
const { authPath } = await import('../src/session.js');
after(() => rm(directory, { recursive: true, force: true }));
const projectId = '0123456789abcdef01234567';
const newId = 'bbbbbbbbbbbbbbbbbbbbbbbb';

test('upload destination and local source checks reject invalid inputs', async () => {
  assert.deepEqual(uploadDestination('/tmp/file.tex', 'chapters/file.tex'), { path: 'chapters/file.tex', name: 'file.tex', folderPath: 'chapters' });
  for (const path of ['../file.tex', '/file.tex', 'a//file.tex', 'a\\file.tex']) assert.throws(() => uploadDestination('/tmp/file', path));
  assert.throws(() => uploadDestination('/tmp/file', 'a'.repeat(150)), /shorter than 150/);
  assert.throws(() => uploadDestination('relative.tex'));
  const file = join(directory, 'large.bin');
  await writeFile(file, '12345');
  await assert.rejects(loadUpload(file, 4), /limit/);
  await assert.rejects(loadUpload(directory, 10), /regular file/);
  assert.equal(uploadedTextMatches(Buffer.from('中文\r\n'), '中文\n'), 'normalized-text');
  assert.equal(uploadedTextMatches(Buffer.from('original'), 'changed'), 'different');
});

function backend(existing: boolean, collision = false) {
  const entries = existing ? [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', path: 'file.tex', kind: 'doc' }] : [] as any[];
  const contents = new Map<string, string>(entries.map(entry => [entry.id, 'original']));
  const sentNames: string[] = [];
  const context = {
    storageState: async () => ({ cookies: [], origins: [] }),
    request: { post: async (_url: string, options: any) => {
      const name = options.multipart.name;
      assert.ok(name.length <= 150, 'Overleaf rejects upload names longer than 150 characters');
      sentNames.push(name);
      const old = entries.findIndex(entry => entry.path === name);
      if (old >= 0) entries.splice(old, 1);
      entries.push({ id: newId, path: name, kind: 'doc' });
      contents.set(newId, options.multipart.qqfile.buffer.toString('utf8'));
      return { status: () => 200, ok: () => true, headers: () => ({ 'content-type': 'application/json' }), json: async () => ({ success: true, entity_id: newId, entity_type: 'doc' }), dispose: async () => {} };
    } },
  };
  const client = Reflect.construct(OverleafClient, [{}, context, { evaluate: async () => ({ csrf: 'test', maxBytes: 1024 }) }]) as any;
  client.project = async () => ({ dirtyTree: false });
  client.getProject = async () => ({ files: entries, folders: [{ id: 'root', path: '' }] });
  client.readFile = async (_projectId: string, path: string) => {
    const file = entries.find(entry => entry.path === path)!;
    return { docId: file.id, version: 0, content: contents.get(file.id) };
  };
  client.request = async (_path: string, method: string, body: any) => {
    assert.equal(method, 'POST');
    if (collision) { entries.push({ id: 'cccccccccccccccccccccccc', path: body.name, kind: 'doc' }); throw new Error('duplicate_file_name'); }
    if (entries.some(entry => entry.path === body.name)) throw new Error('duplicate_file_name');
    entries.find(entry => entry.id === newId)!.path = body.name;
  };
  return { client, entries, contents, sentNames };
}

test('default upload refuses duplicates; overwrite=true explicitly replaces them', async () => {
  const source = join(directory, 'replacement.tex');
  await writeFile(source, 'replacement');
  const server = backend(true);
  await assert.rejects(server.client.uploadFile(projectId, source, 'file.tex'), /FILE_EXISTS/);
  assert.equal(server.sentNames.length, 0);
  assert.equal(server.contents.get('aaaaaaaaaaaaaaaaaaaaaaaa'), 'original');
  const result = await server.client.uploadFile(projectId, source, 'file.tex', true);
  assert.equal(result.uploaded, true);
  assert.equal(result.verified, true);
  assert.equal(result.overwriteAllowed, true);
  assert.deepEqual(server.sentNames, ['file.tex']);
});

test('create-only upload uses a temporary name and preserves a concurrent same-name file', async () => {
  const source = join(directory, 'new.tex');
  await writeFile(source, 'new file');
  const server = backend(false, true);
  const result = await server.client.uploadFile(projectId, source, 'file.tex');
  assert.equal(result.uploaded, true);
  assert.equal(result.verified, false);
  assert.equal(result.placedAtRequestedPath, false);
  assert.notEqual(server.sentNames[0], 'file.tex');
  assert.equal(server.entries.find(entry => entry.path === 'file.tex')!.id, 'cccccccccccccccccccccccc');
});

test('a valid filename with a long extension does not produce an overlong staging name', async () => {
  const source = join(directory, 'long-extension.bin');
  await writeFile(source, 'payload');
  const name = 'a.' + 'x'.repeat(147);
  const server = backend(false);
  const result = await server.client.uploadFile(projectId, source, name);
  assert.equal(result.verified, true);
  assert.equal(result.path, name);
  assert.ok(server.sentNames[0].length <= 150);
});

test('session-file protection survives an atomic cookie refresh during the upload read', async t => {
  await fs.promises.mkdir(join(directory, 'state'), { recursive: true });
  await writeFile(authPath, 'synthetic old session');
  const originalOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args: any[]) => {
    const handle = await originalOpen(...args as Parameters<typeof originalOpen>);
    if (String(args[0]) === await fs.promises.realpath(authPath)) {
      await writeFile(`${authPath}.new`, 'synthetic refreshed session');
      await fs.promises.rename(`${authPath}.new`, authPath);
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(loadUpload(authPath, 1024), /session cannot be uploaded/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
