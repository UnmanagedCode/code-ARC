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

// Boots a throwaway copy of the backend whose .venv is a symlink to an empty
// dir: the toolkit reports `diverged`, so the banner (detail + fix) shows.
export async function bootDiverged() {
  const { cp, mkdtemp, mkdir, rm, symlink } = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'code-arc-diverged-'));
  const copy = path.join(tmp, 'checkout');
  for (const p of ['server.js', 'package.json', 'requirements.txt', 'conductor.plugin.json', 'src', 'frontend', 'sidecar']) {
    await cp(path.join(REPO, p), path.join(copy, p), { recursive: true });
  }
  await mkdir(path.join(tmp, 'shared-venv'));
  await symlink(path.join(tmp, 'shared-venv'), path.join(copy, '.venv'));
  const srv = await bootServer({ cwd: copy, entry: 'server.js', silent: true, sandbox: { dirs: { CONDUCTOR_PLUGIN_DATA_DIR: 'data' } } });
  return { ...srv, async close() { await srv.close(); await rm(tmp, { recursive: true, force: true }); } };
}
