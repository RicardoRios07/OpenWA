import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAdvisories, evaluate } from './check-audit.mjs';

/**
 * The report shape is taken from a real `npm audit --json` run, not invented: one advisory
 * (extract-zip) surfaces as FIVE package entries, and only the directly-vulnerable one carries the
 * advisory object in `via`. The other four name their parent as a plain string. A gate that counted
 * package entries instead of advisories would need four more allowlist ids for one problem.
 */
const advisory = {
  source: 1139346,
  name: 'extract-zip',
  url: 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv',
  severity: 'high',
  title: 'extract-zip unvalidated symlink path traversal',
};

const puppeteerReport = {
  vulnerabilities: {
    'extract-zip': { name: 'extract-zip', severity: 'high', via: [advisory] },
    '@puppeteer/browsers': { name: '@puppeteer/browsers', severity: 'high', via: ['extract-zip'] },
    puppeteer: { name: 'puppeteer', severity: 'high', via: ['@puppeteer/browsers'] },
    'puppeteer-core': { name: 'puppeteer-core', severity: 'high', via: ['@puppeteer/browsers'] },
    'whatsapp-web.js': { name: 'whatsapp-web.js', severity: 'high', via: ['puppeteer'] },
  },
};

const ALLOW = [{ id: 'GHSA-jmr9-qjv8-65gv', package: 'extract-zip', reason: 'x', removeWhen: 'y' }];

test('five package entries for one advisory collapse to a single advisory', () => {
  const found = collectAdvisories(puppeteerReport);
  assert.equal(found.size, 1);
  assert.equal(found.get('GHSA-jmr9-qjv8-65gv').package, 'extract-zip');
});

test('the allowlisted advisory passes', () => {
  assert.deepEqual(evaluate(puppeteerReport, ALLOW), []);
});

// The load-bearing negative. Without this the gate could allowlist everything and still look green.
test('the SAME advisory fails once it is not allowlisted', () => {
  const errors = evaluate(puppeteerReport, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /GHSA-jmr9-qjv8-65gv/);
  assert.match(errors[0], /HIGH/);
});

test('a DIFFERENT high advisory still fails while one is allowlisted', () => {
  const report = {
    vulnerabilities: {
      ...puppeteerReport.vulnerabilities,
      tar: {
        name: 'tar',
        severity: 'high',
        via: [{ name: 'tar', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 'x' }],
      },
    },
  };
  const errors = evaluate(report, ALLOW);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /GHSA-aaaa-bbbb-cccc/);
});

test('critical is blocking too, not just high', () => {
  const report = {
    vulnerabilities: {
      x: {
        name: 'x',
        severity: 'critical',
        via: [{ name: 'x', url: 'https://github.com/advisories/GHSA-crit-0000-0000', severity: 'critical', title: 'x' }],
      },
    },
  };
  assert.equal(evaluate(report, []).length, 1);
});

test('moderate and low do not block', () => {
  const report = {
    vulnerabilities: {
      x: {
        name: 'x',
        severity: 'moderate',
        via: [{ name: 'x', url: 'https://github.com/advisories/GHSA-mod-0000-0000', severity: 'moderate', title: 'x' }],
      },
    },
  };
  assert.deepEqual(evaluate(report, []), []);
});

/**
 * The rule that stops the carve-out outliving its cause. When whatsapp-web.js ships a puppeteer
 * carrying @puppeteer/browsers 3.x the advisory disappears, and without this the entry would sit
 * there indefinitely, quietly excusing an id nobody re-examines.
 */
test('an allowlist entry whose advisory is gone fails as stale', () => {
  const errors = evaluate({ vulnerabilities: {} }, ALLOW);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Stale allowlist entry GHSA-jmr9-qjv8-65gv/);
});

test('a clean report with an empty allowlist passes', () => {
  assert.deepEqual(evaluate({ vulnerabilities: {} }, []), []);
});

// npm omits the key entirely when nothing is found; treating that as a crash would fail every
// green build, and treating a crash as "clean" would fail open. It must simply be empty.
test('a report with no vulnerabilities key is clean, not a crash', () => {
  assert.deepEqual(evaluate({}, []), []);
  assert.equal(collectAdvisories(undefined).size, 0);
});
