import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// index.css gives html[lang='he'] and html[lang='ar'] their own font stack. A font-family declared on
// body or #root beats the value those would inherit, so the Hebrew and Arabic fonts the entry point
// bundles would never render and those scripts would fall back to a system font.

const SRC = dirname(fileURLToPath(import.meta.url));
const cssFiles = (readdirSync(SRC, { recursive: true }) as string[]).filter(f => f.endsWith('.css'));

test('no stylesheet sets a font-family on body or #root', () => {
  for (const file of cssFiles) {
    const css = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectorList, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = selectorList.split(',').map(s => s.trim());
      if (!selectors.some(s => s === 'body' || s === '#root')) continue;
      assert.doesNotMatch(body, /(^|;|\s)font-family\s*:/, `${file}: ${selectorList.trim()} sets a font-family`);
    }
  }
});
