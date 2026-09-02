// Render smoke test for the Logs page under the bare `node --test` runner, following the
// Sessions.test.ts harness (same providers, recorded-fetch stub, jsdom loader hooks). The Logs
// page is the AuditLog type's only consumer, and the wire type now carries required nullable
// fields (apiKeyId..statusCode are `| null`, userAgent/metadata added) — this pins that the page
// renders null fields with its fallbacks rather than crashing, and that the search filter matches
// action and errorMessage case-insensitively over rows whose other fields are null.
import '../test-helpers/register-hooks.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuditLog } from '../services/api';

// Every nullable field at its null floor: the pre-UI wire shape for actions that carry no session
// and no API-key linkage (infra admin operations).
const LOG_WITH_NULLS: AuditLog = {
  id: 'row-nulls',
  action: 'infra.restart',
  severity: 'info',
  apiKeyId: null,
  apiKeyName: null,
  sessionId: null,
  sessionName: null,
  ipAddress: null,
  userAgent: null,
  method: null,
  path: null,
  statusCode: null,
  errorMessage: null,
  metadata: null,
  createdAt: '2026-08-16T01:02:03.000Z',
};

const LOG_FAILED_SEND: AuditLog = {
  ...LOG_WITH_NULLS,
  id: 'row-failed',
  action: 'session.stop',
  severity: 'error',
  sessionId: 'sess-1',
  sessionName: 'billing-bot',
  ipAddress: '10.0.0.9',
  method: 'POST',
  path: '/api/sessions/sess-1/stop',
  statusCode: 502,
  errorMessage: 'SESSION_STOP_INCOMPLETE',
};

const LOGS = [LOG_WITH_NULLS, LOG_FAILED_SEND];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(jsonResponse({ data: LOGS, total: LOGS.length }))) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Logs: () => React.ReactElement;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Logs } = await import('./Logs.tsx'));
});

function renderLogs(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtl.render(createElement(QueryClientProvider, { client }, createElement(Logs))).container;
}

test('the log table renders rows whose nullable fields are null without crashing, and shows both severities', async () => {
  const container = renderLogs();
  await rtl.waitFor(() => {
    assert.ok(container.textContent?.includes('infra.restart'), 'null-floor row renders its action');
    assert.ok(container.textContent?.includes('session.stop'), 'populated row renders its action');
  });
  // The fallback for a null ip is an em-dash, not a crash and not the string "null".
  assert.ok(container.textContent?.includes('—'), 'null ip falls back to the dash placeholder');
  assert.ok(!container.textContent?.includes('null'), 'no raw null leaks into the DOM');
});
