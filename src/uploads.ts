import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { authPath } from './session.js';

export function uploadDestination(localPath: string, targetPath?: string) {
  if (!isAbsolute(localPath)) throw new Error('localPath must be an absolute path on the MCP server');
  const path = targetPath ?? basename(localPath);
  const parts = path.split('/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\\\0]/.test(path) || parts.some(part => !part || part === '.' || part === '..')) throw new Error('path must be a project-relative file path without traversal');
  const name = posix.basename(path);
  if (name.length >= 150) throw new Error('The destination filename must be shorter than 150 characters');
  const parent = posix.dirname(path);
  return { path, name, folderPath: parent === '.' ? '' : parent };
}

export async function loadUpload(localPath: string, maxBytes: number) {
  if (!isAbsolute(localPath)) throw new Error('localPath must be an absolute path');
  const sourcePath = await realpath(localPath);
  const credentials = await Promise.all([realpath(authPath), stat(authPath)]).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (sourcePath === credentials?.[0]) throw new Error('The saved Overleaf session cannot be uploaded');
  const file = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('localPath must refer to a regular file');
    if (credentials && credentials[1].dev === info.dev && credentials[1].ino === info.ino) throw new Error('The saved Overleaf session cannot be uploaded');
    if (info.size > maxBytes) throw new Error(`Upload exceeds the server file-size limit (${maxBytes} bytes)`);
    // Bound the read even if another process grows the source after stat().
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes - total + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error('Source file grew beyond the upload limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const buffer = Buffer.concat(chunks, total);
    return { buffer, size: total, sha256: createHash('sha256').update(buffer).digest('hex') };
  } finally { await file.close(); }
}

export function uploadedTextMatches(bytes: Buffer, text: string): 'exact' | 'normalized-text' | 'different' {
  if (Buffer.from(text).equals(bytes)) return 'exact';
  try {
    const normalized = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    return normalized === text ? 'normalized-text' : 'different';
  } catch { return 'different'; }
}
