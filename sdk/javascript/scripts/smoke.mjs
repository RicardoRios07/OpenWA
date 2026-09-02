/**
 * Packaging smoke test: load the BUILT dist/ through Node's real CJS and ESM
 * loaders. Unit tests run under vitest's bundler-like resolver and cannot catch
 * a dual-format misconfig (CJS parsed as ESM, or extensionless ESM specifiers),
 * so this guards `npm publish` against shipping an unconsumable package.
 * Run after `npm run build`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cjs = require('../dist/cjs/index.js');
if (typeof cjs.OpenWAClient !== 'function') throw new Error('CJS: OpenWAClient missing');

const esm = await import(new URL('../dist/esm/index.js', import.meta.url).href);
if (typeof esm.OpenWAClient !== 'function') throw new Error('ESM: OpenWAClient missing');

// Typings smoke: each runtime condition must carry its OWN types entry pointing at the matching
// build. A single top-level "types" condition ahead of "require" makes a node16-family CommonJS
// TypeScript consumer resolve the ESM declaration while linking the CJS build, which fails with
// TS1479 ("The current file is a CommonJS module whose imports will produce 'require' calls")
// against the ESM declarations' `export ... from` syntax. The runtime loaders above cannot see
// this; only the exports-map shape does.
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dot = pkg.exports?.['.'];
for (const [condition, dist] of [
  ['import', 'esm'],
  ['require', 'cjs'],
]) {
  const types = dot?.[condition]?.types;
  if (types !== `./dist/${dist}/index.d.ts`) {
    throw new Error(`exports["."].${condition}.types must point at ./dist/${dist}/index.d.ts (got ${types})`);
  }
  if (dot?.[condition]?.default !== `./dist/${dist}/index.js`) {
    throw new Error(`exports["."].${condition}.default must point at ./dist/${dist}/index.js`);
  }
}
if (dot?.types !== undefined) {
  throw new Error('exports["."] must not carry a top-level "types" condition (see TS1479 note above)');
}

console.log('smoke OK: require() + import() both resolve OpenWAClient, and each condition types itself');
