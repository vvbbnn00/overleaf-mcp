import { diffChars, diffLines } from 'diff';

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

export type TextEdit = { start: number; end: number; text: string };
type TextChange = { value: string; added?: boolean; removed?: boolean };

export function validateInsertedText(text: string, type: string) {
  if (type === 'sharejs-text-ot' && /[\uD800-\uDFFF]/.test(text)) throw new Error('UNSUPPORTED_CHARACTER: this Overleaf document uses legacy OT, which replaces non-BMP characters such as emoji; no write was sent');
  if (Array.from(text).some(char => char.length === 1 && /[\uD800-\uDFFF]/.test(char))) throw new Error('Invalid Unicode surrogate; no write was sent');
}

function localizedChanges(before: string, after: string, deadline: number, offset: number, replacements?: TextEdit[]): TextChange[] {
  let start = 0, suffix = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  // Keep a surrogate pair in one diff region.
  if (start && /[\uD800-\uDBFF]/.test(before[start - 1])) start--;
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  if (suffix && /[\uDC00-\uDFFF]/.test(before[before.length - suffix])) suffix--;
  const changes = diffChars(before.slice(start, before.length - suffix), after.slice(start, after.length - suffix), { timeout: Math.max(0, deadline - Date.now()) });
  if (!changes) throw new Error('DIFF_TOO_COMPLEX: use a smaller exact replacement; no write was sent');
  if (start < before.length - suffix && start < after.length - suffix) {
    replacements?.push({ start: offset + start, end: offset + before.length - suffix, text: after.slice(start, after.length - suffix) });
  }
  return [...(start ? [{ value: before.slice(0, start) }] : []), ...changes, ...(suffix ? [{ value: before.slice(-suffix) }] : [])];
}

function lineChanges(before: string, after: string, deadline: number, offset: number, replacements: TextEdit[]): TextChange[] {
  const lines = diffLines(before, after, { timeout: Math.max(0, deadline - Date.now()) });
  if (!lines) throw new Error('DIFF_TOO_COMPLEX: use a smaller exact replacement; no write was sent');
  const changes: TextChange[] = [];
  let removed = '', added = '';
  const flush = () => {
    const oldLines = removed.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const newLines = added.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (oldLines.length === newLines.length) {
      let lineOffset = offset;
      for (let i = 0; i < oldLines.length; i++) {
        changes.push(...localizedChanges(oldLines[i], newLines[i], deadline, lineOffset, replacements));
        lineOffset += oldLines[i].length;
      }
    } else changes.push(...localizedChanges(removed, added, deadline, offset));
    offset += removed.length;
    removed = ''; added = '';
  };
  for (const line of lines) {
    if (line.removed) removed += line.value;
    else if (line.added) added += line.value;
    else { flush(); changes.push({ value: line.value }); offset += line.value.length; }
  }
  flush();
  return changes;
}

export function textEditPlan(before: string, after: string, type: string, scope?: { start: number; end: number }) {
  if (before === after) return { op: [], edits: [] as TextEdit[], replacements: [] as TextEdit[] };
  if (!['sharejs-text-ot', 'history-ot'].includes(type)) throw new Error(`Unsupported document type: ${type}`);
  const deadline = Date.now() + 1000;
  let replacements: TextEdit[] = [];
  const changes = scope ? [
    { value: before.slice(0, scope.start) },
    ...lineChanges(before.slice(scope.start, scope.end), after.slice(scope.start, scope.end + after.length - before.length), deadline, scope.start, replacements),
    { value: before.slice(scope.end) },
  ] : lineChanges(before, after, deadline, 0, replacements);
  if (scope) replacements = [{ ...scope, text: after.slice(scope.start, scope.end + after.length - before.length) }];
  const edits: TextEdit[] = [];
  let oldPosition = 0, current: TextEdit | undefined;
  for (const change of changes) {
    if (change.added || change.removed) {
      current ??= { start: oldPosition, end: oldPosition, text: '' };
      if (change.added) current.text += change.value;
      else { oldPosition += change.value.length; current.end = oldPosition; }
    } else {
      if (current) { edits.push(current); current = undefined; }
      oldPosition += change.value.length;
    }
  }
  if (current) edits.push(current);
  const legacy: { p: number; i?: string; d?: string }[] = [];
  const modern: (number | string)[] = [];
  let cursor = 0, shift = 0;
  for (const edit of edits) {
    validateInsertedText(edit.text, type);
    if (edit.start > cursor) modern.push(edit.start - cursor);
    const removed = before.slice(edit.start, edit.end), p = edit.start + shift;
    if (removed) legacy.push({ p, d: removed });
    if (edit.text) { legacy.push({ p, i: edit.text }); modern.push(edit.text); }
    if (removed) modern.push(-removed.length);
    cursor = edit.end;
    shift += edit.text.length - removed.length;
  }
  if (cursor < before.length) modern.push(before.length - cursor);
  return { op: type === 'sharejs-text-ot' ? legacy : [{ textOperation: modern }], edits, replacements };
}

export function textEditOperation(before: string, after: string, type: string) {
  return textEditPlan(before, after, type).op;
}

export function replaceExact(content: string, oldText: string, newText: string) {
  if (!oldText) throw new Error('oldText must not be empty');
  const offset = content.indexOf(oldText);
  if (offset < 0) throw new Error('The exact text was not found; read the current file again');
  if (content.indexOf(oldText, offset + 1) >= 0) throw new Error('The exact text occurs more than once; include more context');
  return content.slice(0, offset) + newText + content.slice(offset + oldText.length);
}
