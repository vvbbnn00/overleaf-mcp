import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { stateDir } from './session.js';

export type Artifact = { artifactId: string; filename: string; mimeType: string; size: number; sha256: string; localPath: string; resourceUri: string };
const root = resolve(stateDir, 'artifacts');
export async function saveArtifact(filename: string, bytes: Buffer, mimeType: string): Promise<Artifact> {
  filename = basename(filename).replace(/[^\p{L}\p{N}._-]/gu, '_');
  if (!filename || filename === '.' || filename === '..') throw new Error('Invalid artifact filename');
  const artifactId = randomUUID();
  const directory = resolve(root, artifactId);
  await mkdir(resolve(directory, 'data'), { recursive: true, mode: 0o700 });
  const localPath = resolve(directory, 'data', filename);
  await writeFile(localPath, bytes, { mode: 0o600, flag: 'wx' });
  const artifact = { artifactId, filename, mimeType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), localPath, resourceUri: `overleaf-artifact:///${artifactId}/${encodeURIComponent(filename)}` };
  await writeFile(resolve(directory, 'metadata.json'), JSON.stringify(artifact), { mode: 0o600 });
  return artifact;
}

export async function readArtifact(uri: string) {
  const url = new URL(uri);
  const match = /^\/([a-f\d-]{36})\/([^/]+)$/.exec(url.pathname);
  if (url.protocol !== 'overleaf-artifact:' || url.host || !match) throw new Error('Invalid artifact URI');
  const filename = decodeURIComponent(match[2]);
  if (basename(filename) !== filename) throw new Error('Invalid artifact filename');
  const directory = resolve(root, match[1]);
  const info: Artifact = JSON.parse(await readFile(resolve(directory, 'metadata.json'), 'utf8'));
  if (info.filename !== filename || info.artifactId !== match[1]) throw new Error('Artifact not found');
  const path = resolve(info.localPath);
  // Older artifacts used the directory directly; new payloads are separate from metadata.
  if (path !== resolve(directory, 'data', filename) && path !== resolve(directory, filename)) throw new Error('Invalid artifact location');
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('Artifact is too large to embed; use the returned localPath');
  return { info, bytes: await readFile(path) };
}
