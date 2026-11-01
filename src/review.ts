import { validateInsertedText, type TextEdit } from './model.js';

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
  validateInsertedText(quote, snapshot.type);
  return snapshot.type === 'history-ot'
    ? [{ commentId: threadId, ranges: [{ pos: start, length: quote.length }] }]
    : [{ p: start, c: quote, t: threadId }];
}

export function commentRangeOperations(snapshot: any, plan: { edits: TextEdit[]; replacements: TextEdit[] }, after: string) {
  const modern = snapshot.type === 'history-ot';
  const comments = modern ? snapshot.reviewComments ?? [] : (snapshot.ranges?.comments ?? []).map((comment: any) => ({
    id: comment.id, ranges: [{ pos: comment.op.p, length: decodeLegacy(comment.op.c ?? '').length }],
  }));
  const operations: unknown[] = [];
  for (const comment of comments) {
    const ranges = comment.ranges.map((range: any) => ({ start: range.pos, end: range.pos + range.length }));
    let update = false;
    for (const range of ranges) {
      const regions = plan.replacements.filter(edit => range.start <= edit.start && range.end >= edit.end);
      let shift = 0, previousRegion: TextEdit | undefined;
      for (const part of plan.edits) {
        const region = regions.find(edit => part.start >= edit.start && part.end <= edit.end);
        if (region && region === previousRegion) continue;
        previousRegion = region;
        const edit = region ?? part;
        const from = edit.start + shift, to = edit.end + shift, inserted = edit.text.length;
        const delta = inserted - (to - from);
        if (from === to) {
          if (from <= range.start) { range.start += inserted; range.end += inserted; }
          else if (from < range.end) { range.end += inserted; update ||= modern && inserted > 0; }
        } else if (to <= range.start) {
          range.start += delta; range.end += delta;
        } else if (from < range.end) {
          if (range.start === range.end) { range.start = range.end = from + inserted; }
          else {
            const replacesBoundary = range.start >= from || range.end <= to;
            range.start = Math.min(range.start, from);
            range.end = range.end > to ? range.end + delta : from + inserted;
            update ||= inserted > 0 && (modern || replacesBoundary);
          }
        }
        shift += delta;
      }
    }
    if (!update) continue;
    if (modern) {
      operations.push({ commentId: comment.id, ranges: ranges.filter((range: any) => range.end > range.start).map((range: any) => ({ pos: range.start, length: range.end - range.start })), resolved: comment.resolved ?? false });
    } else {
      const range = ranges[0];
      const text = after.slice(range.start, range.end);
      validateInsertedText(text, snapshot.type);
      operations.push({ p: range.start, c: text, t: comment.id });
    }
  }
  return operations;
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
    // At one offset, remove the inserted text before restoring deleted text.
    for (const change of selected.sort((a: any, b: any) => b.op.p - a.op.p || Number(typeof b.op.i === 'string') - Number(typeof a.op.i === 'string'))) {
      const insertion = typeof change.op.i === 'string';
      const text = decodeLegacy(insertion ? change.op.i : change.op.d);
      const p = change.op.p;
      if (insertion) {
        if (expectedContent.slice(p, p + text.length) !== text) throw new Error("VERSION_CONFLICT: refresh the file and its tracked changes.");
        op.push({ p, d: text, u: true });
        expectedContent = expectedContent.slice(0, p) + expectedContent.slice(p + text.length);
      } else {
        // Use the same Unicode checks as ordinary source edits.
        validateInsertedText(text, snapshot.type);
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
