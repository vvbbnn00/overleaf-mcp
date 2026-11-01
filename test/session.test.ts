import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSession } from '../src/session.js';

test('login failures are distinguished from temporary service errors and retry delays', async () => {
  for (const [status, headers, expected, retryAfterSeconds] of [
    [401, {}, false, undefined],
    [302, { location: '/login' }, false, undefined],
    [403, { 'content-type': 'text/html' }, null, 60],
    [429, { 'retry-after': '30' }, null, 30],
    [503, { 'content-type': 'text/html', 'retry-after': '120' }, null, 120],
  ] as const) {
    const context = { cookies: async () => [], request: { get: async () => ({ status: () => status, headers: () => headers, dispose: async () => {} }) } };
    const result = await probeSession(context as any);
    assert.equal(result.authenticated, expected);
    assert.equal(result.retryAfterSeconds, retryAfterSeconds);
  }
});
