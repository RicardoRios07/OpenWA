import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * main.ts boots on import, so its banner and advisories cannot be exercised by a unit test; lock the
 * source instead, the way load-env.spec.ts locks its import order. A raw console line bypasses
 * LOG_LEVEL and, in production, lands as plain text in an otherwise JSON log stream.
 */
describe('bootstrap logging', () => {
  it.each(['main.ts', 'configure-app.ts'])('%s writes through the structured logger, not console', file => {
    const source = readFileSync(resolve(__dirname, file), 'utf8');

    expect(source).not.toMatch(/\bconsole\.\w+\(/);
  });
});
