import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { FAKES, freshEnv, ROOT } from './_helpers.mjs';

// A scrubbed env: nothing from the developer's shell or a real cc.
const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });

function run(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, out: () => out, err: () => err };
}

test('without an absolute CONDUCTOR_PLUGIN_DATA_DIR the server exits non-zero with a clear message', async () => {
  for (const extra of [{}, { CONDUCTOR_PLUGIN_DATA_DIR: 'relative/dir' }]) {
    const p = run({ ...baseEnv(), ...extra });
    assert.notEqual(await p.exited, 0);
    assert.match(p.err(), /CONDUCTOR_PLUGIN_DATA_DIR must be set to an absolute path/);
  }
});

test('with a valid env it serves health on 127.0.0.1 and stops on SIGTERM', async (t) => {
  const env = await freshEnv(t);
  const p = run({ ...baseEnv(), CONDUCTOR_PLUGIN_DATA_DIR: env.dataDir, PROJECTS_ROOT: env.projectsRoot, PORT: '0', CODE_ARC_PYTHON: 'python3', CODE_ARC_TEST_TOOLKIT_DIR: FAKES });
  t.after(() => p.child.kill('SIGKILL'));
  let port = null;
  for (let i = 0; i < 200 && !port; i++) {
    port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(p.out())?.[1] ?? null;
    if (!port) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(port, `no listening line; stderr: ${p.err()}`);
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  p.child.kill('SIGTERM');
  assert.equal(await p.exited, 0);
});
