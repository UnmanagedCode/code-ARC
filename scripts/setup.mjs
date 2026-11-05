// Builds this checkout's .venv in the foreground, the same way the backend
// does on start. Exits non-zero on failure. Run it in the main checkout so new
// worktrees share a ready venv.
import path from 'node:path';
import { createBootstrap } from '../src/bootstrap.js';
import { bundleLocations } from '../src/bundle.js';
import { CHECKOUT_DIR } from '../src/config.js';

// An offline bundle (docs/bundle.md) in CODE_ARC_BUNDLE or the data dir is used
// the same way the backend uses it.
const dataDir = process.env.CONDUCTOR_PLUGIN_DATA_DIR;
const bootstrap = createBootstrap({
  checkoutDir: CHECKOUT_DIR,
  bundle: bundleLocations(process.env, dataDir && path.isAbsolute(dataDir) ? dataDir : null),
  onChange: (s) => console.log(`[code-arc setup] ${s.state}${s.phase ? ` (${s.phase})` : ''}`),
});
await bootstrap.run();
const s = bootstrap.status();
if (s.state !== 'ready') {
  console.error(`[code-arc setup] ${s.state}: ${s.detail || ''}`);
  process.exit(1);
}
console.log(`[code-arc setup] ready: ${s.python}`);
