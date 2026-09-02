#!/usr/bin/env node
/**
 * Dependency-audit gate for the ROOT tree, with a per-advisory allowlist.
 *
 * `npm audit --audit-level=high` is all-or-nothing: it fails on any high, and the only lever it
 * offers is lowering the threshold for EVERYTHING. That lever is the wrong one — the audit job
 * exists to fence high-severity regressions, and dropping it to `critical` would silently un-gate
 * every future high to accommodate one advisory that has no fix.
 *
 * So the threshold stays, and an advisory is excused ONE AT A TIME, by id, with its reason recorded
 * next to it. An excused advisory is still visible in `npm audit` output; what changes is only
 * whether CI treats it as a stop.
 *
 * Two rules, and the second is the one that keeps this honest:
 *   1. Any advisory at `high` or `critical` whose id is not allowlisted FAILS.
 *   2. An allowlist entry whose advisory no longer appears ALSO FAILS. A carve-out that outlives
 *      its cause is how a gate quietly narrows, so removing it is not left to anyone remembering.
 *
 * Scope: the root tree only. `dashboard/` keeps a plain `npm audit --audit-level=high`, because it
 * has nothing to excuse and should stay the stricter of the two.
 *
 * Run locally: `npm run check:audit`.
 */
import { execFileSync } from 'node:child_process';

/**
 * Advisories CI will not stop on. Every entry states why, and what removes it.
 *
 * Keep this list empty whenever possible. An entry belongs here only when there is no patched
 * version to move to, the reachable path is understood, and the fix is upstream rather than ours.
 */
const ALLOWLIST = [
  {
    id: 'GHSA-jmr9-qjv8-65gv',
    package: 'extract-zip',
    reason:
      'No patched version exists — the advisory covers extract-zip * and 2.0.1 is the latest publish. ' +
      'It reaches us only through @puppeteer/browsers <=2.13.2, which puppeteer-core 24.38.0 pins EXACTLY, ' +
      'and puppeteer 24.38.0 is itself pinned exactly by whatsapp-web.js 1.34.7 — so nothing we can express ' +
      'in overrides moves it. @puppeteer/browsers 3.x drops extract-zip for modern-tar, but forcing it past ' +
      'those pins pulls yargs 18 and modern-tar (both type:module) into a CommonJS Jest run and 60 suites ' +
      'fail to load; that was measured, not assumed. ' +
      'Reachability: the vulnerable path is zip extraction inside `puppeteer browsers install`, which this ' +
      'repo calls once, at IMAGE BUILD time, on amd64 only (Dockerfile — arm64 symlinks Debian chromium and ' +
      'never calls it), against a version-pinned Chrome for Testing build fetched from Google over HTTPS. ' +
      'Nothing in the shipped image extracts a zip through this path at runtime.',
    removeWhen:
      'whatsapp-web.js ships a release whose puppeteer pin carries @puppeteer/browsers 3.x. Re-check with ' +
      '`npm view whatsapp-web.js dependencies.puppeteer` then `npm view puppeteer-core@<v> dependencies`.',
  },
];

const BLOCKING = new Set(['high', 'critical']);

/**
 * `npm audit --json` exits non-zero exactly when it found something, so a throw is the normal path
 * and the payload is on stdout either way. Anything that is not parseable JSON is a real failure —
 * a network error or a broken registry — and must not read as "no vulnerabilities".
 */
function runAudit() {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    const stdout = err?.stdout ?? '';
    try {
      return JSON.parse(stdout);
    } catch {
      console.error('check:audit — could not read `npm audit --json` output:');
      console.error(err?.stderr || err?.message || String(err));
      process.exit(1);
    }
  }
}

/**
 * Every distinct advisory in the report, keyed by its GHSA id.
 *
 * npm reports one entry per affected package, but only the directly-vulnerable one carries the
 * advisory OBJECT in `via`; the packages that merely depend on it carry a plain string naming their
 * parent. Collecting the objects is therefore what enumerates advisories rather than symptoms — the
 * extract-zip advisory shows up as five package entries and exactly one advisory.
 */
export function collectAdvisories(report) {
  const found = new Map();
  for (const entry of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop();
      if (!found.has(id)) {
        found.set(id, { id, package: via.name, severity: via.severity, title: via.title, url: via.url });
      }
    }
  }
  return found;
}

/** The gate's verdict, split out so a spec can drive it without shelling out to npm. */
export function evaluate(report, allowlist = ALLOWLIST) {
  const advisories = collectAdvisories(report);
  const allowed = new Set(allowlist.map(a => a.id));
  const errors = [];

  for (const advisory of advisories.values()) {
    if (!BLOCKING.has(advisory.severity)) continue;
    if (allowed.has(advisory.id)) continue;
    errors.push(
      `${advisory.severity.toUpperCase()} ${advisory.id} in ${advisory.package}: ${advisory.title}\n` +
        `  ${advisory.url}\n` +
        '  Fix it, or — only if there is no patched version and the path is understood — add it to\n' +
        '  ALLOWLIST in scripts/check-audit.mjs with a reason and a removeWhen.',
    );
  }

  for (const entry of allowlist) {
    if (advisories.has(entry.id)) continue;
    errors.push(
      `Stale allowlist entry ${entry.id} (${entry.package}): the advisory no longer appears in npm audit.\n` +
        '  Remove it from ALLOWLIST in scripts/check-audit.mjs — an exception that outlives its cause\n' +
        '  narrows this gate for everything that comes after it.',
    );
  }

  return errors;
}

// Guarded so the spec can import the two functions above without running a real audit.
if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runAudit();
  const errors = evaluate(report);

  if (errors.length > 0) {
    console.error('check:audit failed:\n');
    for (const error of errors) console.error(`- ${error}\n`);
    process.exit(1);
  }

  const excused = ALLOWLIST.length;
  console.log(
    `check:audit passed — no unexcused high/critical advisories in the root tree` +
      (excused > 0 ? ` (${excused} allowlisted: ${ALLOWLIST.map(a => a.id).join(', ')})` : ''),
  );
}
