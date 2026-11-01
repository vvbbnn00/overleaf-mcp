import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const directory = await mkdtemp(join(tmpdir(), 'overleaf-login-test-'));
process.env.OVERLEAF_STATE_DIR = directory;
const { authPath, baseUrl, browserLogin, probeSession } = await import('../src/session.js');
after(() => rm(directory, { recursive: true, force: true }));

test('successful login saves the session and closes the browser without waiting for user input', async t => {
  const state = { cookies: [], origins: [] };
  let closed = false;
  const browser = Object.assign(new EventEmitter(), {
    newContext: async () => ({
      newPage: async () => ({ goto: async () => {}, waitForFunction: async () => {} }),
      storageState: async () => state,
    }),
    close: async () => {
      assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), { baseUrl, state });
      closed = true;
      browser.emit('disconnected');
    },
  });
  t.after(() => browser.emit('disconnected'));
  t.mock.method(chromium, 'launch', async () => browser);
  t.mock.method(console, 'error', () => {});

  await browserLogin();
  assert.equal(closed, true);
});

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
