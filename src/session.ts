import { chromium, type Browser, type BrowserContext } from 'playwright';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { safeErrorMessage } from './errors.js';

export const baseUrl = (process.env.OVERLEAF_BASE_URL ?? 'https://www.overleaf.com').replace(/\/$/, '');
export const stateDir = resolve(process.env.OVERLEAF_STATE_DIR ?? '.overleaf-mcp');
export const authPath = resolve(stateDir, 'session.json');

export class AuthenticationError extends Error {}

export type SessionStatus = {
  authenticated: boolean | null;
  status: number | null;
  reason: 'authenticated' | 'login-required' | 'not-configured' | 'unavailable';
  cookies: Array<{ name: string; expiresAt: string | null; remainingSeconds: number | null; expiryAdvancedSeconds: number; httpOnly: boolean; secure: boolean; sameSite: string }>;
  checkedAt: string;
  retryAfterSeconds?: number;
  rollingExpiryObserved?: boolean;
  nextKeepaliveAt?: string;
};

export async function prepareStateDir() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
}

let pendingSave: Promise<void> = Promise.resolve();

export function saveSession(context: BrowserContext) {
  const next = pendingSave.catch(() => {}).then(() => writeSession(context));
  pendingSave = next;
  return next;
}

async function writeSession(context: BrowserContext) {
  await prepareStateDir();
  const state = await context.storageState();
  const host = new URL(baseUrl).hostname;
  // Persist only cookies for this Overleaf instance, never third-party login cookies.
  state.cookies = state.cookies.filter(c => host === c.domain.replace(/^\./, '') || host.endsWith(c.domain.startsWith('.') ? c.domain : `.${c.domain}`));
  state.origins = state.origins.filter(o => o.origin === new URL(baseUrl).origin);
  const temporary = `${authPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ baseUrl, state }), { mode: 0o600 });
  await rename(temporary, authPath);
}

export async function loadSession() {
  const saved = JSON.parse(await readFile(authPath, 'utf8'));
  if (saved.baseUrl !== baseUrl) throw new Error('Saved session belongs to a different Overleaf instance. Use a separate OVERLEAF_STATE_DIR.');
  return saved.state;
}

export async function launchBrowser(headless: boolean): Promise<Browser> {
  return chromium.launch({ channel: process.env.OVERLEAF_BROWSER_CHANNEL ?? 'chrome', headless });
}

export async function browserLogin() {
  await prepareStateDir();
  let saved;
  try { saved = await loadSession(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const browser = await launchBrowser(false);
  const close = () => { void browser.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    const context = await browser.newContext({ storageState: saved, viewport: null });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/project`, { waitUntil: 'domcontentloaded' });
    console.error('Browser opened. Complete login manually. Passwords are not read or submitted by this program.');
    await page.waitForFunction(() => {
      const id = document.querySelector('meta[name="ol-user_id"]')?.getAttribute('content');
      return Boolean(id) && /^\/project(?:\/|$)/.test(location.pathname);
    }, undefined, { timeout: 0 });
    await saveSession(context);
    console.error('Login confirmed. Session saved with owner-only permissions. Browser remains open for live editing tests.');
    await new Promise<void>(resolve => browser.once('disconnected', () => resolve()));
  } finally {
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    await browser.close();
  }
}

export async function authenticatedContext() {
  const saved = await loadSession();
  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext({ storageState: saved });
    return { browser, context };
  } catch (error) { await browser.close(); throw error; }
}

export async function inspectSavedSession(): Promise<SessionStatus> {
  try { await loadSession(); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    return { authenticated: false, status: null, reason: 'not-configured', cookies: [], checkedAt: new Date().toISOString() };
  }
  const { browser, context } = await authenticatedContext();
  try { return await probeSession(context); }
  finally { await browser.close(); }
}

export async function probeSession(context: BrowserContext): Promise<SessionStatus> {
  const before = await context.cookies(baseUrl);
  const response = await context.request.get(`${baseUrl}/user/features`, { maxRedirects: 0 }).catch(error => { throw new Error(safeErrorMessage(error)); });
  const status = response.status();
  const headers = response.headers();
  await response.dispose();
  const contentType = headers['content-type'] ?? '';
  const authenticated = status === 200 && contentType.includes('application/json') ? true
    : status === 401 || ([301, 302, 303, 307, 308].includes(status) && /\/login(?:[?#]|$)/.test(headers.location ?? '')) ? false : null;
  const retryAfter = headers['retry-after'];
  const retryAfterSeconds = retryAfter ? (Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000) : 60;
  if (authenticated) await saveSession(context);
  const after = await context.cookies(baseUrl);
  return {
    authenticated,
    status,
    reason: authenticated === true ? 'authenticated' : authenticated === false ? 'login-required' : 'unavailable',
    ...(authenticated === null ? { retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? Math.max(1, retryAfterSeconds) : 60 } : {}),
    cookies: after.filter(c => /session|sid/i.test(c.name)).map(c => ({
      name: c.name,
      expiresAt: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
      remainingSeconds: c.expires > 0 ? Math.round(c.expires - Date.now() / 1000) : null,
      expiryAdvancedSeconds: c.expires - (before.find(b => b.name === c.name && b.domain === c.domain)?.expires ?? c.expires),
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
    checkedAt: new Date().toISOString(),
  };
}
