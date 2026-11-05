// Boots the backend in a sandbox (temp data dir and projects root) on the
// fake toolkit, so the viewer can be driven without network or a venv.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';

const { bootServer } = await import(BROWSER);
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function bootArc() {
  return bootServer({
    cwd: REPO,
    entry: 'server.js',
    silent: true,
    sandbox: { dirs: { CONDUCTOR_PLUGIN_DATA_DIR: 'data', PROJECTS_ROOT: 'root' } },
    env: { CODE_ARC_PYTHON: 'python3', CODE_ARC_TEST_TOOLKIT_DIR: path.join(REPO, 'sidecar', 'tests', 'fakes') },
  });
}

// Calls a tool the way cc does: POST api/mcp with the caller identity.
export async function mcp(url, tool, args = {}, caller = { sessionId: 'demo-session', project: 'demo' }) {
  const res = await fetch(`${url}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, arguments: args, caller }) });
  return res.json();
}
