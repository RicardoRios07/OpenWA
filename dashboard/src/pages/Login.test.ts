// Login page under the bare `node --test` runner, on the jsdom harness the other page tests use. The
// key typed at sign-in is the one the dashboard stores and compares against its API key prefixes, so it
// must be stored trimmed; and the form's alignment must follow the document direction set on <html>.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';

let sentKey: string | null = null;

function installFetchStub(): void {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sentKey = new Headers(init?.headers).get('X-API-Key');
    return Promise.resolve(
      new Response(JSON.stringify({ valid: true, role: 'admin' }), { headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Login: (typeof import('./Login.tsx'))['Login'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-01-01T00:00:00.000Z';
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Login } = await import('./Login.tsx'));
});

afterEach(() => {
  sentKey = null;
  rtl.cleanup();
});

test('a key pasted with surrounding whitespace is sent and stored trimmed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const logins: string[] = [];
  rtl.render(createElement(Login, { onLogin: (key: string) => logins.push(key) }));

  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '  owa_k1_secret ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

  await waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(logins, ['owa_k1_secret']);
  assert.equal(sentKey, 'owa_k1_secret');
});

test('the login form aligns to the document direction, which is set on <html>', () => {
  const css = readFileSync(fileURLToPath(new URL('./Login.css', import.meta.url)), 'utf8');
  // i18n sets `dir` on the document element only, so a `[dir]` compound after another selector part
  // would need a second element carrying `dir` inside the page and never matches.
  assert.deepEqual(css.match(/[^\s,{}][^,{}]*\s\[dir[^\]]*\][^{]*/g) ?? [], []);
  assert.match(css, /\.login-container \.login-form \{\s*text-align: start;\s*\}/);
});
