// Playwright appends HTTP headers (including cookies) to network exceptions.
// Keep the operation/error summary, not the request log, when reporting failures.
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/, 1)[0]
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[URL redacted]')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-csrf-token)\s*[:=].*/gi, '$1: [redacted]');
}
