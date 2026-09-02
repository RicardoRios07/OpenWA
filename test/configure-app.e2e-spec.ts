import { Module, INestApplication, Controller, Post, Body } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configureApp } from '../src/configure-app';
import { applyGlobalValidation } from '../src/config/app-validation';
import { DASHBOARD_CSP_NONCE_PLACEHOLDER } from '../src/config/dashboard-csp';

/**
 * The production HTTP surface, run for real. Every other e2e builds a bare Nest app, so the stack
 * main.ts installs (nonce, helmet, body caps, CORS, the SPA document handler) was executed by
 * nothing, and the one suite that needed the document handler carried its own copy of it, minus the
 * nonce injection. These assertions fail if the copy and the original ever diverge again, because
 * there is no copy left to diverge.
 */
@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: unknown) {
    return { received: typeof body };
  }
}

@Module({ controllers: [EchoController] })
class HttpSurfaceModule {}

// A stand-in for the bundled document: the real dashboard/index.html carries the placeholder in a
// meta element, which Plugins.tsx reads to copy the nonce onto its sandboxed iframe's scripts.
const distDir = join(mkdtempSync(join(tmpdir(), 'openwa-surface-')), 'dashboard', 'dist');
mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, 'index.html'),
  `<!doctype html><html><head><meta name="openwa-csp-nonce" content="${DASHBOARD_CSP_NONCE_PLACEHOLDER}" />` +
    `</head><body><script nonce="${DASHBOARD_CSP_NONCE_PLACEHOLDER}"></script></body></html>`,
);

describe('production HTTP surface (configureApp)', () => {
  let app: INestApplication<App>;

  const previousBodyLimit = process.env.BODY_SIZE_LIMIT;
  const previousCorsOrigins = process.env.CORS_ORIGINS;

  beforeAll(async () => {
    // Pin the cap here rather than inheriting the lane's: configureApp reads it at call time, and a
    // suite that depends on ambient env asserts whatever the runner happened to set. 1mb makes the
    // aggregate budget 4mb (four times the per-request cap), so the two layers are separable.
    process.env.BODY_SIZE_LIMIT = '1mb';
    // Without an explicit allowlist the policy is a wildcard, which allows every origin and would
    // make the denial assertion below pass on any implementation.
    process.env.CORS_ORIGINS = 'https://allowed.example';
    // `bodyParser: false` matches main.ts: configureApp installs the only parsers, with the caps.
    app = await NestFactory.create<INestApplication<App>>(HttpSurfaceModule, { bodyParser: false, logger: false });
    configureApp(app, { dashboard: { distDir, enabled: true } });
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousBodyLimit === undefined) delete process.env.BODY_SIZE_LIMIT;
    else process.env.BODY_SIZE_LIMIT = previousBodyLimit;
    if (previousCorsOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previousCorsOrigins;
  });

  it('serves a document whose nonce matches the one in its own CSP header', async () => {
    const res = await request(app.getHttpServer()).get('/').set('Accept', 'text/html').expect(200);

    const csp = res.headers['content-security-policy'];
    const fromHeader = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    expect(fromHeader).toBeTruthy();
    // The document must carry THAT value, not a placeholder and not a different nonce: a mismatch
    // means the browser refuses every script the page declares.
    expect(res.text).toContain(`content="${fromHeader}"`);
    expect(res.text).toContain(`nonce="${fromHeader}"`);
    expect(res.text).not.toContain(DASHBOARD_CSP_NONCE_PLACEHOLDER);
  });

  it('gives each response its own nonce', async () => {
    const nonceOf = async (): Promise<string | undefined> => {
      const res = await request(app.getHttpServer()).get('/').set('Accept', 'text/html').expect(200);
      return /'nonce-([A-Za-z0-9_-]+)'/.exec(res.headers['content-security-policy'])?.[1];
    };
    // A shared nonce would let one document's value satisfy another's CSP, which is the whole
    // reason the document is served dynamically rather than statically.
    expect(await nonceOf()).not.toEqual(await nonceOf());
  });

  it('echoes the CORS header for an allowed Origin', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Origin', 'https://allowed.example')
      .send({});

    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
  });

  it('denies a disallowed Origin by omitting the CORS headers, not by failing the request', async () => {
    // Deliberately an /api route: the document handler answers `/` before the CORS layer is
    // reached, so asserting the denial there passes whatever CORS does.
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Origin', 'https://evil.example')
      .send({});

    // Throwing here surfaced as a 500 once (#250). The browser is what must block the response.
    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('admits a body under the per-request cap', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(900 * 1024) });

    expect(res.status).toBe(201);
  });

  it('refuses a body over the per-request cap with 413', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(1100 * 1024) });

    expect(res.status).toBe(413);
  });

  it('refuses a declared body over the aggregate in-flight budget with 503, a different layer', async () => {
    // The budget is a PRE-guard: it answers on the DECLARED length, before the parser reads a byte,
    // which is what stops slow-body memory pinning that no route guard can reach. Asserting it by
    // actually uploading an oversized body is timing-dependent: the server refuses and destroys
    // the socket while the client is still writing, so the client sees ECONNRESET instead of the
    // response often enough to flake. Declaring the size and sending almost nothing tests the same
    // decision deterministically.
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(8 * 1024 * 1024))
      // Bounded on purpose: if the guard ever stops refusing, the parser waits for a body that is
      // never coming and this hangs instead of failing. A hang is not a red.
      .timeout({ deadline: 5000, response: 5000 })
      .send('{}');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('answers a compressed body with 415 rather than charging the budget its inflated size', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send('{}');

    expect(res.status).toBe(415);
  });
});
