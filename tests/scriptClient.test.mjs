// The Python client (clients/code_arc.py) against a real backend on the fake
// toolkit, driven by tests/fixtures/client_driver.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { json, ok, ROOT, startApp } from './_helpers.mjs';
import { STEP_RATE_MAX, STEP_RATE_WINDOW_MS } from '../src/limits.js';

const run = promisify(execFile);
const DRIVER = path.join(ROOT, 'tests', 'fixtures', 'client_driver.py');
const manualTimers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };

async function drive(script, scenario) {
  const { stdout } = await run('python3', ['-I', DRIVER, path.dirname(script.client), script.base_url, script.token, scenario], { timeout: 20000 });
  return JSON.parse(stdout);
}

async function scripted(mcp) {
  const r = await mcp('start_session', { game_id: 'fake-maze' });
  const s = ok(r);
  return { sid: s.session_id, script: s.script };
}

test('grid is 64x64 ints equal to the stored step frame', async (t) => {
  const { url, mcp } = await startApp(t);
  const { sid, script } = await scripted(mcp);
  const out = await drive(script, 'grid');
  assert.deepEqual([out.step, out.run], [1, 1]);
  assert.deepEqual(out.available, ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6']);
  const stored = (await json(`${url}/api/sessions/${sid}/steps?from=1`)).body.steps[0];
  assert.equal(stored.source, 'script');
  assert.equal(out.grid.length, 64);
  assert.deepEqual(out.grid, stored.frame.map((row) => [...row].map((c) => parseInt(c, 16))));
});

test('refusals raise Refusal with the server code', async (t) => {
  const { mcp } = await startApp(t);
  const { script } = await scripted(mcp);
  const out = await drive(script, 'refusals');
  assert.deepEqual(out.unavailable, { code: 'ACTION_UNAVAILABLE', available_actions: ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6'] });
  assert.equal(out.stale, 'RUN_SUPERSEDED');
  const fresh = await scripted(mcp);
  assert.deepEqual(await drive(fresh.script, 'no_run'), { code: 'NOTE_REQUIRED' });
});

test('STEP_RATE_LIMITED raises with retry_after_ms and is never retried', async (t) => {
  const frozen = Date.parse('2026-01-01T00:00:00Z');
  const clock = { now: () => frozen };
  const { url, mcp, calls } = await startApp(t, { clock, timers: manualTimers });
  const { sid, script } = await scripted(mcp);
  const out = await drive(script, 'rate');
  assert.deepEqual(out, { acts: STEP_RATE_MAX - 1, code: 'STEP_RATE_LIMITED', retry_after_ms: STEP_RATE_WINDOW_MS });
  const meta = (await json(`${url}/api/sessions/${sid}`)).body;
  assert.equal(meta.step_count, STEP_RATE_MAX - 1, 'only the admitted acts were recorded');
  assert.equal((await calls()).filter((c) => c.op === 'step').length, STEP_RATE_MAX - 1);
});
