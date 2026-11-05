import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { startApp, startGame, until } from './_helpers.mjs';
import { createLineSplitter } from '../src/sidecar.js';
import { DEADLINES, SIDECAR_LINE_MAX } from '../src/limits.js';

test('a toolkit printing to stdout does not corrupt the protocol', async (t) => {
  const { mcp, log } = await startApp(t);
  const sid = await startGame(mcp, 'fake-noisy');
  const r = await mcp('act', { session_id: sid, action: 'ACTION1' });
  assert.equal(r.meta.step, 1);
  await until(() => log.lines.some((l) => l.includes('[sidecar] fake-noisy: plain chatter')));
  assert.ok(log.lines.some((l) => l.startsWith('[sidecar] {"id": 1, "ok": true')), 'protocol-shaped noise went to stderr');
});

test('a hung toolkit call times out, stalls the session, and health stays fast', async (t) => {
  const { mcp, url } = await startApp(t, { deadlines: { ...DEADLINES, step: 200 } });
  const sid = await startGame(mcp, 'fake-hang');
  const pending = mcp('act', { session_id: sid, action: 'ACTION1' });
  const t0 = performance.now();
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  assert.ok(performance.now() - t0 < 200, 'health answered within 200 ms while the toolkit hangs');
  const r = (await pending).result;
  assert.equal(r.code, 'TOOLKIT_TIMEOUT');
  const again = (await mcp('act', { session_id: sid, action: 'ACTION1' })).result;
  assert.equal(again.code, 'SESSION_STALLED');
  assert.equal((await mcp('observe', { session_id: sid })).meta.step, 0);
  const listed = (await mcp('list_sessions')).result.sessions.find((s) => s.session_id === sid);
  assert.equal(listed.stalled, true);
  // A stalled session can still be ended.
  assert.equal((await mcp('end_session', { session_id: sid })).result.ok, true);
});

test('a late reply is recorded and un-stalls the session', async (t) => {
  const { mcp, app } = await startApp(t, { deadlines: { ...DEADLINES, step: 150 } });
  const sid = await startGame(mcp, 'fake-slow');
  assert.equal((await mcp('act', { session_id: sid, action: 'ACTION4' })).result.code, 'TOOLKIT_TIMEOUT');
  assert.equal(app.store.get(sid).stalled, true);
  await until(() => app.store.get(sid).stalled === false);
  assert.equal(app.store.get(sid).step_count, 1, 'the late step is in the history');
  assert.equal((await app.store.readSteps(sid, 1, 10))[0].action, 'ACTION4');
  assert.equal((await mcp('observe', { session_id: sid })).meta.step, 1);
});

test('a crashing toolkit ends live sessions and the next call respawns', async (t) => {
  const { mcp, app } = await startApp(t);
  const other = await startGame(mcp, 'fake-maze');
  const sid = await startGame(mcp, 'fake-crash');
  const pid = app.sidecar.pid();
  const r = (await mcp('act', { session_id: sid, action: 'ACTION1' })).result;
  assert.equal(r.code, 'SIDECAR_EXITED');
  await until(() => app.store.get(other).status === 'ended');
  assert.equal(app.store.get(other).end_reason, 'sidecar_exit');
  assert.equal(app.store.get(sid).end_reason, 'sidecar_exit');
  const next = await startGame(mcp, 'fake-maze');
  assert.ok(next);
  assert.notEqual(app.sidecar.pid(), pid);
});

// Stands in for the sidecar: becomes ready, configures, then answers the next
// request with a line over the protocol limit.
const OVERSIZED = `
process.stdout.write(JSON.stringify({ event: 'ready', versions: { arc_agi: '0.9.9', arcengine: '0.9.3' } }) + '\\n');
let n = 0;
process.stdin.on('data', (d) => {
  for (const line of d.toString().split('\\n').filter(Boolean)) {
    const req = JSON.parse(line);
    if (n++ === 0) process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: {} }) + '\\n');
    else process.stdout.write('x'.repeat(${SIDECAR_LINE_MAX} + 10) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

test('a protocol line over the size limit kills the sidecar', async (t) => {
  const spawn = (cmd, args, opts) => nodeSpawn(process.execPath, ['-e', OVERSIZED], opts);
  const { mcp, log } = await startApp(t, { spawn });
  const r = (await mcp('list_games')).result;
  assert.equal(r.code, 'SIDECAR_EXITED');
  assert.ok(log.lines.some((l) => l.includes(`over ${SIDECAR_LINE_MAX} bytes`)));
});

test('line splitter: lines across chunks, overflow skips to the next line', () => {
  const lines = [];
  let overflows = 0;
  const feed = createLineSplitter({ max: 5, onLine: (l) => lines.push(l), onOverflow: () => overflows++ });
  feed(Buffer.from('ab'));
  feed(Buffer.from('c\nde'));
  feed(Buffer.from('f\n123456789\nok\n'));
  assert.deepEqual(lines, ['abc', 'def', 'ok']);
  assert.equal(overflows, 1);
});
