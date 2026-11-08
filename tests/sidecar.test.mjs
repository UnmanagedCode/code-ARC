import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { ok, refusal, startApp, startGame, until } from './_helpers.mjs';
import { createLineSplitter } from '../src/sidecar.js';
import { DEADLINES, SIDECAR_LINE_MAX } from '../src/limits.js';

test('a toolkit printing to stdout does not corrupt the protocol', async (t) => {
  const { mcp, log } = await startApp(t);
  const sid = await startGame(mcp, 'fake-noisy');
  const r = await mcp('act', { session_id: sid, action: 'ACTION1' });
  assert.equal(ok(r).step, 1);
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
  refusal(await pending, 'TOOLKIT_TIMEOUT');
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'SESSION_STALLED');
  assert.equal(ok(await mcp('observe', { session_id: sid })).step, 0);
  const listed = ok(await mcp('list_sessions')).sessions.find((s) => s.session_id === sid);
  assert.equal(listed.stalled, true);
  // A stalled session can still be ended.
  ok(await mcp('end_session', { session_id: sid }));
});

test('a late reply is recorded and un-stalls the session', async (t) => {
  const { mcp, app } = await startApp(t, { deadlines: { ...DEADLINES, step: 150 } });
  const sid = await startGame(mcp, 'fake-slow');
  ok(await mcp('note', { session_id: sid, note: 'plan' }));
  refusal(await mcp('act', { session_id: sid, action: 'ACTION4' }), 'TOOLKIT_TIMEOUT');
  assert.equal(app.store.get(sid).stalled, true);
  await until(() => app.store.get(sid).stalled === false);
  assert.equal(app.store.get(sid).step_count, 1, 'the late step is in the history');
  const step = (await app.store.readSteps(sid, 1, 10))[0];
  assert.equal(step.action, 'ACTION4');
  // Pins: the late step keeps the source and run it was issued under.
  assert.deepEqual([step.source, step.run], ['script', 1]);
  assert.equal(ok(await mcp('observe', { session_id: sid })).step, 1);
});

// Pins: a late step belongs to the run current when it was issued, not the one current when it lands.
test('a late reply keeps the run of its call even after a later note', async (t) => {
  const { mcp, app } = await startApp(t, { deadlines: { ...DEADLINES, step: 150 } });
  const sid = await startGame(mcp, 'fake-slow');
  ok(await mcp('note', { session_id: sid, note: 'first' }));
  refusal(await mcp('act', { session_id: sid, action: 'ACTION4' }), 'TOOLKIT_TIMEOUT');
  assert.equal(ok(await mcp('note', { session_id: sid, note: 'second' })).run, 2);
  await until(() => app.store.get(sid).stalled === false);
  const step = (await app.store.readSteps(sid, 1, 10))[0];
  assert.deepEqual([step.source, step.run], ['script', 1]);
  assert.deepEqual((await app.store.readNotes(sid)).map((n) => [n.run, n.from_step]), [[1, 1], [2, 1]]);
});

test('a crashing toolkit ends live sessions and the next call respawns', async (t) => {
  const { mcp, app } = await startApp(t);
  const other = await startGame(mcp, 'fake-maze');
  const sid = await startGame(mcp, 'fake-crash');
  const pid = app.sidecar.pid();
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'SIDECAR_EXITED');
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
  refusal(await mcp('list_games'), 'SIDECAR_EXITED');
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
