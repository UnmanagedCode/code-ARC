// Offline bundle CLI (docs/bundle.md).
//   node scripts/bundle.mjs export [<out>.arcbundle]
//   node scripts/bundle.mjs import <archive> [--replace] [--expect-sha256 <hex>]
// Exit 0 on success, 1 on a bundle or bootstrap error (CODE: message, then
// the fix), 2 on a usage error.
import path from 'node:path';
import { BootstrapError } from '../src/bootstrap.js';
import { BundleError, LICENSE_NOTICE } from '../src/bundle.js';
import { exportBundle } from '../src/bundleExport.js';
import { importBundle } from '../src/bundleImport.js';
import { CHECKOUT_DIR, loadConfig } from '../src/config.js';
import { createKeyStore } from '../src/keyStore.js';

const USAGE = `usage:
  node scripts/bundle.mjs export [<out>.arcbundle]
  node scripts/bundle.mjs import <archive> [--replace] [--expect-sha256 <hex>]`;

function usage(msg) {
  if (msg) console.error(`bundle: ${msg}`);
  console.error(USAGE);
  process.exit(2);
}

function report(r, verb) {
  const t = r.manifest.target;
  console.log(`${verb}: ${r.out || r.dir}`);
  console.log(`bundle id (sha256 of its manifest): ${r.id}`);
  console.log(`target: ${t.implementation} ${t.python} ${t.system} ${t.machine}${t.libc ? ` ${t.libc}` : ''}`);
  console.log(`games: ${r.manifest.games.length}`);
  console.log(`\n${LICENSE_NOTICE}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const env = process.env;
const testToolkitDir = env.CODE_ARC_TEST_TOOLKIT_DIR ? path.resolve(CHECKOUT_DIR, env.CODE_ARC_TEST_TOOLKIT_DIR) : null;

try {
  if (cmd === 'export') {
    if (rest.length > 1 || rest.some((a) => a.startsWith('--'))) usage('export takes at most one output path');
    const out = rest[0] ? path.resolve(rest[0]) : null;
    const dataDir = env.CONDUCTOR_PLUGIN_DATA_DIR;
    let apiKey = null;
    if (dataDir && path.isAbsolute(dataDir)) apiKey = await createKeyStore({ dataDir }).get();
    console.log(apiKey ? `using the API key saved in ${dataDir}` : 'using the toolkit\'s anonymous key (no saved API key found)');
    const r = await exportBundle({ out, apiKey, pythonOverride: env.CODE_ARC_PYTHON || null, testToolkitDir });
    report(r, 'exported');
    console.log('\nCarry the bundle id to the offline host separately and pass it to import --expect-sha256.');
  } else if (cmd === 'import') {
    let archive = null;
    let replace = false;
    let expectId = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--replace') replace = true;
      else if (a === '--expect-sha256') {
        expectId = rest[++i];
        if (!expectId || !/^[0-9a-f]{64}$/.test(expectId)) usage('--expect-sha256 needs a 64-hex-digit bundle id');
      } else if (a.startsWith('--')) usage(`unknown option ${a}`);
      else if (archive === null) archive = path.resolve(a);
      else usage('import takes one archive');
    }
    if (!archive) usage('import needs an archive');
    let config;
    try {
      config = loadConfig(env);
    } catch (e) {
      if (e instanceof BundleError) throw e;
      usage(e.message);
    }
    if (config.bundle.envPath) console.warn(`warning: CODE_ARC_BUNDLE (${config.bundle.envPath}) is set and shadows the imported bundle`);
    const r = await importBundle({ archive, dataDir: config.dataDir, checkoutDir: CHECKOUT_DIR, replace, expectId });
    report(r, 'imported');
    console.log('\nRestart the plugin to use it.');
  } else {
    usage(cmd ? `unknown command ${cmd}` : null);
  }
} catch (e) {
  if (e instanceof BundleError || e instanceof BootstrapError) {
    console.error(`${e.code}: ${e.message}`);
    if (e.fix) console.error(`Fix: ${e.fix}`);
    process.exit(1);
  }
  throw e;
}
