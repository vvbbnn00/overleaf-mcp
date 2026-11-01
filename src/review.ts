import { textEditOperation } from './model.js';

const decodeLegacy = (text: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text, c => c.charCodeAt(0)));
const modernChangeId = (change: any) => `change-${change.tracking.type}-${change.range.pos}`;

function position(content: string, offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) return null;
  const lines = content.slice(0, offset).split('\n');
  return { offset, line: lines.length, column: lines.at(-1)!.length + 1 };
}

export function documentReview(path: string, snapshot: any) {
  const comments = [];
  const changes = [];
  if (snapshot.type === 'history-ot') {
    for (const comment of snapshot.reviewComments ?? []) {
      comments.push({ threadId: comment.id, resolved: comment.resolved, ranges: comment.ranges.map((range: any) => ({ start: position(snapshot.content, range.pos), end: position(snapshot.content, range.pos + range.length), text: snapshot.content.slice(range.pos, range.pos + range.length) })) });
    }
    for (const change of snapshot.reviewChanges ?? []) {
      changes.push({ id: modernChangeId(change), kind: change.tracking.type, start: position(snapshot.content, change.range.pos), end: position(snapshot.content, change.range.pos + change.range.length), text: snapshot.content.slice(change.range.pos, change.range.pos + change.range.length), metadata: change.tracking });
    }
  } else {
    for (const comment of snapshot.ranges?.comments ?? []) {
      const text = decodeLegacy(comment.op.c ?? '');
      comments.push({ threadId: comment.id, ranges: [{ start: position(snapshot.content, comment.op.p), end: position(snapshot.content, comment.op.p + text.length), text }] });
    }
    for (const change of snapshot.ranges?.changes ?? []) {
      const insertion = typeof change.op.i === 'string';
      const text = decodeLegacy(insertion ? change.op.i : change.op.d ?? '');
      changes.push({ id: change.id, kind: insertion ? 'insert' : 'delete', start: position(snapshot.content, change.op.p), end: position(snapshot.content, change.op.p + (insertion ? text.length : 0)), text, metadata: change.metadata });
    }
  }
  return { path, docId: snapshot.docId, version: snapshot.version, comments, trackedChanges: changes, receivedAt: snapshot.receivedAt };
}

export function commentOperation(snapshot: any, quote: string, threadId: string) {
  const start = snapshot.content.indexOf(quote);
  if (!quote || start < 0) throw new Error("Select text from a fresh read_file result.");
  if (snapshot.content.indexOf(quote, start + 1) >= 0) throw new Error("Include more surrounding text to select a unique passage.");
  textEditOperation('', quote, snapshot.type);
  return snapshot.type === 'history-ot'
    ? [{ commentId: threadId, ranges: [{ pos: start, length: quote.length }] }]
    : [{ p: start, c: quote, t: threadId }];
}

export function trackedChangePlan(snapshot: any, changeIds: string[], action: 'accept' | 'reject') {
  const ids = new Set(changeIds);
  const modern = snapshot.type === 'history-ot';
  const available = modern ? snapshot.reviewChanges ?? [] : snapshot.ranges?.changes ?? [];
  const selected = available.filter((change: any) => ids.has(modern ? modernChangeId(change) : change.id));
  if (!ids.size || selected.length !== ids.size) throw new Error("Read get_review again and select current change IDs.");
  let expectedContent: string = snapshot.content;
  if (!modern) {
    if (action === 'accept') return { op: [], expectedContent };
    const op: unknown[] = [];
    for (const change of selected.sort((a: any, b: any) => b.op.p - a.op.p)) {
      const insertion = typeof change.op.i === 'string';
      const text = decodeLegacy(insertion ? change.op.i : change.op.d);
      const p = change.op.p;
      if (insertion) {
        if (expectedContent.slice(p, p + text.length) !== text) throw new Error("VERSION_CONFLICT: refresh the file and its tracked changes.");
        op.push({ p, d: text, u: true });
        expectedContent = expectedContent.slice(0, p) + expectedContent.slice(p + text.length);
      } else {
        // Use the same Unicode checks as ordinary source edits.
        textEditOperation('', text, snapshot.type);
        op.push({ p, i: text, u: true });
        expectedContent = expectedContent.slice(0, p) + text + expectedContent.slice(p);
      }
    }
    return { op, expectedContent };
  }
  const operations: unknown[] = [];
  let cursor = 0;
  const retained: string[] = [];
  for (const change of selected.sort((a: any, b: any) => a.range.pos - b.range.pos)) {
    const { pos, length } = change.range;
    if (pos < cursor) throw new Error("Refresh get_review to select distinct change ranges.");
    if (pos > cursor) operations.push(pos - cursor);
    retained.push(snapshot.content.slice(cursor, pos));
    const remove = (change.tracking.type === 'delete') === (action === 'accept');
    operations.push(remove ? -length : { r: length, tracking: { type: 'none' } });
    if (!remove) retained.push(snapshot.content.slice(pos, pos + length));
    cursor = pos + length;
  }
  if (cursor < snapshot.content.length) operations.push(snapshot.content.length - cursor);
  retained.push(snapshot.content.slice(cursor));
  return { op: [{ textOperation: operations }], expectedContent: retained.join('') };
}
