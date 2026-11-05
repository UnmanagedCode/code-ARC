// Builds this checkout's .venv in the foreground, the same way the backend
// does on start. Exits non-zero on failure. Run it in the main checkout so new
// worktrees share a ready venv.
import { createBootstrap } from '../src/bootstrap.js';
import { CHECKOUT_DIR } from '../src/config.js';

const bootstrap = createBootstrap({
  checkoutDir: CHECKOUT_DIR,
  onChange: (s) => console.log(`[code-arc setup] ${s.state}${s.phase ? ` (${s.phase})` : ''}`),
});
await bootstrap.run();
const s = bootstrap.status();
if (s.state !== 'ready') {
  console.error(`[code-arc setup] ${s.state}: ${s.detail || ''}`);
  process.exit(1);
}
console.log(`[code-arc setup] ready: ${s.python}`);
