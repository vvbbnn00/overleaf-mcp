import yauzl from 'yauzl';
import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

export function archivePath(root: string, name: string) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new Error(`Unsafe archive path: ${name}`);
  const path = resolve(root, name);
  if (!path.startsWith(resolve(root) + sep)) throw new Error(`Unsafe archive path: ${name}`);
  return path;
}

export async function extractProject(zipPath: string, directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return new Promise<{ files: number; bytes: number }>((resolveResult, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('Could not open ZIP')); return; }
      let files = 0, bytes = 0;
      const fail = (error: unknown) => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', () => resolveResult({ files, bytes }));
      zip.on('entry', entry => {
        void (async () => {
          const path = archivePath(directory, entry.fileName);
          const mode = entry.externalFileAttributes >>> 16;
          if ((mode & 0o170000) === 0o120000) throw new Error('Symbolic links in project archives are not supported');
          if (++files > 10000 || (bytes += entry.uncompressedSize) > 512 * 1024 * 1024) throw new Error('Expanded project exceeds the extraction limit');
          if (entry.fileName.endsWith('/')) await mkdir(path, { recursive: true, mode: 0o700 });
          else {
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => zip.openReadStream(entry, (err, stream) => err || !stream ? rejectStream(err) : resolveStream(stream)));
            await pipeline(stream, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}
