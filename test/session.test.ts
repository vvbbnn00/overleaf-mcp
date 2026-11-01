import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSession } from '../src/session.js';

test('a temporary service error is not reported as an expired login', async () => {
  const context = {
    cookies: async () => [],
    request: { get: async () => ({ status: () => 503, headers: () => ({ 'content-type': 'text/html', 'retry-after': '120' }), dispose: async () => {} }) },
  };
  const result = await probeSession(context as any);
  assert.equal(result.authenticated, null);
  assert.equal(result.retryAfterSeconds, 120);
});

test('a login redirect is distinguished from a challenge page', async () => {
  for (const [status, headers, expected] of [
    [302, { location: '/login' }, false],
    [403, { 'content-type': 'text/html' }, null],
    [429, { 'retry-after': '30' }, null],
  ] as const) {
    const context = { cookies: async () => [], request: { get: async () => ({ status: () => status, headers: () => headers, dispose: async () => {} }) } };
    assert.equal((await probeSession(context as any)).authenticated, expected);
  }
});
