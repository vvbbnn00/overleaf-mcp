function position(content: string, offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) return null;
  const lines = content.slice(0, offset).split('\n');
  return { offset, line: lines.length, column: lines.at(-1)!.length + 1 };
}

export function documentReview(path: string, snapshot: any) {
  const decode = (text: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text, c => c.charCodeAt(0)));
  const comments = [];
  const changes = [];
  if (snapshot.type === 'history-ot') {
    for (const comment of snapshot.reviewComments ?? []) {
      comments.push({ threadId: comment.id, resolved: comment.resolved, ranges: comment.ranges.map((range: any) => ({ start: position(snapshot.content, range.pos), end: position(snapshot.content, range.pos + range.length), text: snapshot.content.slice(range.pos, range.pos + range.length) })) });
    }
    for (const change of snapshot.reviewChanges ?? []) {
      changes.push({ kind: change.tracking.type, start: position(snapshot.content, change.range.pos), end: position(snapshot.content, change.range.pos + change.range.length), text: snapshot.content.slice(change.range.pos, change.range.pos + change.range.length), metadata: change.tracking });
    }
  } else {
    for (const comment of snapshot.ranges?.comments ?? []) {
      const text = decode(comment.op.c ?? '');
      comments.push({ threadId: comment.id, ranges: [{ start: position(snapshot.content, comment.op.p), end: position(snapshot.content, comment.op.p + text.length), text }] });
    }
    for (const change of snapshot.ranges?.changes ?? []) {
      const insertion = typeof change.op.i === 'string';
      const text = decode(insertion ? change.op.i : change.op.d ?? '');
      changes.push({ id: change.id, kind: insertion ? 'insert' : 'delete', start: position(snapshot.content, change.op.p), end: position(snapshot.content, change.op.p + (insertion ? text.length : 0)), text, metadata: change.metadata });
    }
  }
  return { path, docId: snapshot.docId, version: snapshot.version, comments, trackedChanges: changes, receivedAt: snapshot.receivedAt };
}
