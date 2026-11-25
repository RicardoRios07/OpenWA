/** Backport the whatsapp-web.js auth-readiness interval-polling fix. */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CLIENT = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

function patchAuthPolling(clientFile = DEFAULT_CLIENT) {
  if (!fs.existsSync(clientFile)) throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  const source = fs.readFileSync(clientFile, 'utf8');
  if (source.includes('WWEBJS_AUTH_POLLING_PATCH')) return { skipped: true, reason: 'already applied' };

  const first = /(waitForFunction\('window\.Debug\?\.VERSION != undefined',\s*\{\s*timeout: authTimeout,\n)(\s*signal: abort\.signal,)/;
  if (!first.test(source)) throw new Error('auth readiness shape not found; refusing a blind patch');
  let updated = source.replace(first, "$1                    polling: 200, // WWEBJS_AUTH_POLLING_PATCH\n$2");

  const second = /(\{\s*timeout: authTimeout)(\s*\},)/;
  if (!second.test(updated)) throw new Error('socket readiness shape not found; refusing a partial patch');
  updated = updated.replace(second, "$1,\n                    polling: 200, // WWEBJS_AUTH_POLLING_PATCH\n                $2");
  if ((updated.match(/WWEBJS_AUTH_POLLING_PATCH/g) || []).length !== 2) {
    throw new Error('auth polling patch did not land at both readiness gates');
  }
  fs.writeFileSync(clientFile, updated);
  return { skipped: false, patched: true };
}

if (require.main === module) {
  try {
    const clientArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
    console.log(JSON.stringify(patchAuthPolling(clientArg || DEFAULT_CLIENT)));
  } catch (error) {
    if (process.argv.includes('--best-effort')) {
      console.warn(`auth polling patch skipped: ${error instanceof Error ? error.message : error}`);
      process.exit(0);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = { patchAuthPolling };
