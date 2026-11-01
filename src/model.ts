import { diffChars } from 'diff';

export type ProjectFile = { id: string; path: string; kind: 'doc' | 'file' };

export function flattenFiles(root: any): ProjectFile[] {
  const files: ProjectFile[] = [];
  function visit(folder: any, prefix: string) {
    for (const doc of folder.docs ?? []) files.push({ id: doc._id, path: `${prefix}${doc.name}`, kind: 'doc' });
    for (const file of folder.fileRefs ?? []) files.push({ id: file._id, path: `${prefix}${file.name}`, kind: 'file' });
    for (const child of folder.folders ?? []) visit(child, `${prefix}${child.name}/`);
  }
  for (const folder of Array.isArray(root) ? root : [root]) if (folder) visit(folder, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function flattenFolders(root: any) {
  const folders: { id: string; path: string }[] = [];
  function visit(folder: any, path: string) {
    folders.push({ id: folder._id, path });
    for (const child of folder.folders ?? []) visit(child, path ? `${path}/${child.name}` : child.name);
  }
  for (const folder of Array.isArray(root) ? root : [root]) if (folder) visit(folder, '');
  return folders;
}

export function selectLines(content: string, startLine?: number, endLine?: number) {
  const lines = content.split('\n');
  const start = startLine ?? 1;
  const end = endLine ?? lines.length;
  if (!Number.isInteger(start) || start < 1 || start > lines.length || !Number.isInteger(end) || end < start) throw new Error('Invalid line range');
  return { content: lines.slice(start - 1, end).join('\n'), startLine: start, endLine: Math.min(end, lines.length), totalLines: lines.length };
}

export function renewalDelay(remainingSeconds: number) {
  // Based on observed expiration, not an assumption about Overleaf's lifetime.
  return Math.max(1000, Math.min(6 * 60 * 60 * 1000, remainingSeconds * 500));
}

export function textEditOperation(before: string, after: string, type: string) {
  if (before === after) return [];
  if (!['sharejs-text-ot', 'history-ot'].includes(type)) throw new Error(`Unsupported document type: ${type}`);
  // Keep unchanged islands intact: deleting and reinserting them loses comment anchors.
  // diffChars tokenizes code points; OT positions remain UTF-16 code-unit offsets.
  const changes = diffChars(before, after, { timeout: 1000 });
  if (!changes) throw new Error('DIFF_TOO_COMPLEX: use a smaller exact replacement; no write was sent');
  const legacy: { p: number; i?: string; d?: string }[] = [];
  const modern: (number | string)[] = [];
  let cursor = 0;
  for (const change of changes) {
    if (change.added) {
      if (type === 'sharejs-text-ot' && /[\uD800-\uDFFF]/.test(change.value)) throw new Error('UNSUPPORTED_CHARACTER: this Overleaf document uses legacy OT, which replaces non-BMP characters such as emoji; no write was sent');
      if (Array.from(change.value).some(char => char.length === 1 && /[\uD800-\uDFFF]/.test(char))) throw new Error('Invalid Unicode surrogate; no write was sent');
      legacy.push({ p: cursor, i: change.value });
      cursor += change.value.length;
      const last = modern.at(-1);
      if (typeof last === 'number' && last < 0) { modern.pop(); modern.push(change.value, last); }
      else modern.push(change.value);
    } else if (change.removed) {
      legacy.push({ p: cursor, d: change.value });
      modern.push(-change.value.length);
    } else {
      cursor += change.value.length;
      modern.push(change.value.length);
    }
  }
  return type === 'sharejs-text-ot' ? legacy : [{ textOperation: modern }];
}

export function replaceExact(content: string, oldText: string, newText: string) {
  if (!oldText) throw new Error('oldText must not be empty');
  const offset = content.indexOf(oldText);
  if (offset < 0) throw new Error('The exact text was not found; read the current file again');
  if (content.indexOf(oldText, offset + 1) >= 0) throw new Error('The exact text occurs more than once; include more context');
  return content.slice(0, offset) + newText + content.slice(offset + oldText.length);
}
