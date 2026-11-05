// Reads the backend's configuration from env. CONDUCTOR_PLUGIN_DATA_DIR is
// required: all state lives there, never in the projects root (this module
// never reads PROJECTS_ROOT).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleLocations } from './bundle.js';

export const CHECKOUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 8791;

export function loadConfig(env = process.env) {
  const dataDir = env.CONDUCTOR_PLUGIN_DATA_DIR;
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw new Error('code-arc: CONDUCTOR_PLUGIN_DATA_DIR must be set to an absolute path (code-conductor sets it for plugin backends; set it yourself to run standalone)');
  }
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`code-arc: PORT must be an integer port (got ${JSON.stringify(env.PORT)})`);
  return {
    dataDir,
    port,
    checkoutDir: CHECKOUT_DIR,
    // Test seams: a ready interpreter (skips the venv bootstrap) and a
    // directory of fake toolkit packages for the sidecar.
    python: env.CODE_ARC_PYTHON || null,
    testToolkitDir: env.CODE_ARC_TEST_TOOLKIT_DIR ? path.resolve(CHECKOUT_DIR, env.CODE_ARC_TEST_TOOLKIT_DIR) : null,
    // Where an offline bundle may be (docs/bundle.md).
    bundle: bundleLocations(env, dataDir),
  };
}
