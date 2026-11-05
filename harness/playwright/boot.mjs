// Boots the backend in a sandbox (temp data dir and projects root) on the
// fake toolkit, so the viewer can be driven without network or a venv.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';

const { bootServer } = await import(BROWSER);
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// `entry` 'harness/playwright/server.mjs' boots with a raised step rate.
export function bootArc({ entry = 'server.js' } = {}) {
  return bootServer({
    cwd: REPO,
    entry,
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

// Boots on a data dir pre-seeded with `n` ended sessions (newest last), as a
// long-used install has, to exercise session-list paging.
export async function bootSeeded(n) {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'code-arc-seeded-'));
  const data = path.join(tmp, 'data');
  for (let i = 0; i < n; i++) {
    const id = `s-${i.toString(16).padStart(12, '0')}`;
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    await mkdir(path.join(data, 'sessions', id), { recursive: true });
    await writeFile(path.join(data, 'sessions', id, 'meta.json'), JSON.stringify({
      id, game_id: 'fake-maze', title: `Old game ${i}`, mode: 'local', owner: { sessionId: 'agent-old', project: 'demo' },
      scorecard_id: 'c', scorecard_url: null, status: 'ended', end_reason: 'ended_by_agent', stalled: false,
      created_at: t, updated_at: t, last_activity_at: t, step_count: 0,
      last: { state: 'NOT_FINISHED', levels_completed: 0, win_levels: 2, available_actions: [1], frame_count: 1, full_reset: true },
    }));
  }
  const srv = await bootServer({
    cwd: REPO, entry: 'server.js', silent: true,
    env: { CONDUCTOR_PLUGIN_DATA_DIR: data, CODE_ARC_PYTHON: 'python3', CODE_ARC_TEST_TOOLKIT_DIR: path.join(REPO, 'sidecar', 'tests', 'fakes') },
  });
  return { ...srv, async close() { await srv.close(); await rm(tmp, { recursive: true, force: true }); } };
}
