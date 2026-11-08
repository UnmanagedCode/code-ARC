import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { createStore } from '../src/store.js';
import { ANIMATION_FRAMES_MAX } from '../src/limits.js';
import { freshEnv, json, ok, refusal, sendJsonReq, startApp, startGame } from './_helpers.mjs';

test('sessions and steps survive a restart; live sessions end as backend_restart', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const sid = await startGame(first.mcp);
  await first.mcp('act', { session_id: sid, action: 'ACTION4', reasoning: 'right' });
  const paint = await first.mcp('act', { session_id: sid, action: 'ACTION6', x: 7, y: 9, frame: 'full' });
  const done = await startGame(first.mcp);
  await first.mcp('end_session', { session_id: done });
  await first.close();

  const second = await startApp(t, { env });
  const meta = second.app.store.get(sid);
  assert.equal(meta.status, 'ended');
  assert.equal(meta.end_reason, 'backend_restart');
  assert.equal(second.app.store.get(done).end_reason, 'ended_by_agent');
  const obs = await second.mcp('observe', { session_id: sid });
  assert.equal(ok(obs).step, 2);
  assert.deepEqual(ok(obs).frame.rows, ok(paint).frame.rows, 'observe rebuilds the last frame from the compressed tail of steps.jsonl');
  const steps = (await json(`${second.url}/api/sessions/${sid}/steps`)).body.steps;
  assert.deepEqual(steps.map((s) => s.action), ['START', 'ACTION4', 'ACTION6']);
  assert.equal(steps[1].reasoning, 'right');
  assert.deepEqual([steps[2].x, steps[2].y], [7, 9]);
  refusal(await second.mcp('act', { session_id: sid, action: 'ACTION1' }), 'SESSION_ENDED');
});

test('state stays in the data dir with private modes; the projects root is untouched', async (t) => {
  const env = await freshEnv(t);
  const { mcp, url } = await startApp(t, { env });
  await startGame(mcp);
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: 'abcdefgh-1234' })).status, 409);
  const sid = ok(await mcp('list_sessions')).sessions[0].session_id;
  await mcp('end_session', { session_id: sid });
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: 'abcdefgh-1234' })).status, 200);
  const mode = async (p) => (await fs.stat(p)).mode & 0o777;
  assert.equal(await mode(env.dataDir), 0o700);
  assert.equal(await mode(path.join(env.dataDir, 'sessions')), 0o700);
  assert.equal(await mode(path.join(env.dataDir, 'toolkit')), 0o700);
  assert.equal(await mode(path.join(env.dataDir, 'secrets.json')), 0o600);
  assert.equal(await mode(path.join(env.dataDir, 'sessions', sid, 'meta.json')), 0o600);
  assert.deepEqual(await fs.readdir(env.projectsRoot), []);
});

test('step lines store a compressed frame; the API returns the same rows; legacy plain-frame lines still read', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const sid = await startGame(first.mcp);
  const paint = await first.mcp('act', { session_id: sid, action: 'ACTION6', x: 7, y: 9, frame: 'full' });
  const apiSteps = (await json(`${first.url}/api/sessions/${sid}/steps`)).body.steps;
  await first.close();

  const file = path.join(env.dataDir, 'sessions', sid, 'steps.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const l of lines) {
    assert.equal(typeof l.frame_z, 'string');
    assert.equal(l.frame, undefined);
    assert.equal(Object.keys(l)[0], 'n');
  }
  assert.equal(apiSteps[1].frame.length, 64);
  assert.equal(apiSteps[1].frame[9][7], '8');
  assert.equal(apiSteps[1].frame_z, undefined);

  // A line written before compression, appended by hand; it becomes the tail.
  const legacy = { ...apiSteps[1], n: 2, action: 'ACTION4', frame: apiSteps[0].frame };
  await fs.appendFile(file, `${JSON.stringify(legacy)}\n`);
  const second = await startApp(t, { env });
  const steps = (await json(`${second.url}/api/sessions/${sid}/steps`)).body.steps;
  assert.deepEqual(steps.map((s) => s.frame), [apiSteps[0].frame, apiSteps[1].frame, apiSteps[0].frame]);
  const paged = (await json(`${second.url}/api/sessions/${sid}/steps?from=1&limit=1`)).body.steps;
  assert.deepEqual(paged.map((s) => s.n), [1]);
  // observe on the ended session reads the last frame from the legacy tail.
  const obs = await second.mcp('observe', { session_id: sid });
  assert.notDeepEqual(ok(obs).frame.rows, ok(paint).frame.rows);
  assert.equal(ok(obs).frame.rows[9][7], apiSteps[0].frame[9][7]);
});

test('notes.jsonl survives a restart', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const sid = await startGame(first.mcp);
  assert.equal(ok(await first.mcp('note', { session_id: sid, note: 'kept across restarts' })).run, 1);
  ok(await first.mcp('act', { session_id: sid, action: 'ACTION4' }));
  await first.close();
  assert.equal(await fs.stat(path.join(env.dataDir, 'sessions', sid, 'notes.jsonl')).then((s) => s.mode & 0o777), 0o600);
  const second = await startApp(t, { env });
  const notes = (await json(`${second.url}/api/sessions/${sid}/notes`)).body.notes;
  assert.deepEqual(notes.map((n) => [n.run, n.text, n.from_step]), [[1, 'kept across restarts', 1]]);
  const step = (await json(`${second.url}/api/sessions/${sid}/steps?from=1`)).body.steps[0];
  assert.deepEqual([step.source, step.run], ['script', 1], 'a stored script step keeps its source and run');
});

test('a tampered frame_z is bounded and read as frame:null: inflate bomb, oversized or non-hex frames', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const sid = await startGame(first.mcp);
  await first.mcp('act', { session_id: sid, action: 'ACTION4' });
  const good = (await json(`${first.url}/api/sessions/${sid}/steps`)).body.steps;
  await first.close();

  const file = path.join(env.dataDir, 'sessions', sid, 'steps.jsonl');
  const z = (text) => deflateRawSync(Buffer.from(text)).toString('base64');
  const base = { ts: good[1].ts, action: 'ACTION4', source: 'tool', state: 'NOT_FINISHED', levels_completed: 0, win_levels: 2, available_actions: [1], frame_count: 1, full_reset: false };
  const tampered = [
    z('0'.repeat(16 * 1024 * 1024)), // inflates far past a frame
    z(Array.from({ length: 65 }, () => '5'.repeat(64)).join('\n')), // 65 rows
    z(Array.from({ length: 64 }, () => '5'.repeat(65)).join('\n')), // 65 columns
    z(Array.from({ length: 64 }, () => 'zz'.repeat(32)).join('\n')), // not hex
    'not base64 deflate',
  ];
  assert.ok(tampered[0].length < 64 * 1024, 'the bomb line is small on disk');
  const lines = tampered.map((frameZ, i) => JSON.stringify({ n: 2 + i, ...base, frame_z: frameZ }));
  lines.push(JSON.stringify({ n: 7, ...base, frame: ['xyz'] })); // a plain frame that is not hex rows
  await fs.appendFile(file, `${lines.join('\n')}\n`);

  const second = await startApp(t, { env });
  const steps = (await json(`${second.url}/api/sessions/${sid}/steps`)).body.steps;
  assert.deepEqual(steps.map((s) => s.n), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(steps.slice(0, 2).map((s) => s.frame), good.map((s) => s.frame), 'good lines are untouched');
  for (const s of steps.slice(2)) assert.equal(s.frame, null, `step ${s.n}`);
  // The tail is tampered: the session has no last frame, and still observes.
  const obs = await second.mcp('observe', { session_id: sid });
  assert.deepEqual(ok(obs).frame, { mode: 'full', rows: null });
  // Pins: the text view says no frame is stored (rather than silently omitting the frame).
  assert.match((await second.mcpText('observe', { session_id: sid })).text, /No frame stored\./);
  assert.equal((await json(`${second.url}/api/health`)).status, 200);
});

test('allow_reset:false persists and survives a restart', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const sid = await startGame(first.mcp, 'fake-maze', { allow_reset: false });
  await first.close();

  const second = await startApp(t, { env });
  const meta = second.app.store.get(sid);
  assert.equal(meta.allow_reset, false);
  assert.equal(meta.end_reason, 'backend_restart');
  const listed = ok(await second.mcp('list_sessions', { scope: 'all' })).sessions.find((s) => s.session_id === sid);
  assert.equal(listed.allow_reset, false);
  assert.equal(ok(await second.mcp('observe', { session_id: sid })).allow_reset, false);
});

test('a legacy meta without allow_reset reads as resets allowed', async (t) => {
  const env = await freshEnv(t);
  const id = 's-000000000001';
  const t0 = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const meta = {
    id, game_id: 'fake-maze', title: 'Legacy', mode: 'local',
    owner: { sessionId: 'agent-a', project: 'proj' }, scorecard_id: 'c', scorecard_url: null,
    status: 'ended', end_reason: 'ended_by_agent', stalled: false, created_at: t0, updated_at: t0, last_activity_at: t0,
    step_count: 0, last: { state: 'NOT_FINISHED', levels_completed: 0, win_levels: 2, available_actions: [1], frame_count: 1, full_reset: true },
  };
  const file = path.join(env.dataDir, 'sessions', id, 'meta.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(meta));
  const { mcp, mcpText, url } = await startApp(t, { env });
  assert.equal(ok(await mcp('observe', { session_id: id })).allow_reset, true);
  assert.match((await mcpText('observe', { session_id: id })).text, /allow_reset: true/);
  assert.equal(ok(await mcp('list_sessions', { scope: 'all' })).sessions.find((s) => s.session_id === id).allow_reset, true);
  assert.equal('allow_reset' in (await json(`${url}/api/sessions/${id}`)).body, false);
  assert.equal('allow_reset' in JSON.parse(await fs.readFile(file, 'utf8')), false);
});

// --- animation frames (anim_z) ---------------------------------------------

const SID = 's-0123456789ab';
const gridRows = (seed) => Array.from({ length: 64 }, (_, y) => Array.from({ length: 64 }, (_, x) => ((x + y + seed) % 16).toString(16)).join(''));
// Incompressible frames: random hex digits.
const noisy = () => Array.from({ length: 64 }, () => randomBytes(32).toString('hex'));

async function storeAt(t, env) {
  env = env || (await freshEnv(t));
  const store = createStore({ dataDir: env.dataDir, log: { error() {} } });
  await store.init();
  return { env, store, file: path.join(env.dataDir, 'sessions', SID, 'steps.jsonl') };
}
const newSession = (store) => store.create({ id: SID, status: 'ended', created_at: 'x', step_count: 0 });
const rawLines = async (file) => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);

test('a multi-frame step line holds frame_z and anim_z, never anim; readSteps hands out neither anim nor anim_z', async (t) => {
  const { store, file } = await storeAt(t);
  await newSession(store);
  const anim = [gridRows(1), gridRows(2)];
  await store.appendStep(SID, { n: 0, action: 'ACTION1', frame: gridRows(3), anim });
  await store.flush();
  const [line] = await rawLines(file);
  assert.match(line, /^\{"n":0,/, 'n stays the first key');
  const raw = JSON.parse(line);
  assert.equal(typeof raw.frame_z, 'string');
  assert.equal(typeof raw.anim_z, 'string');
  assert.ok(!('anim' in raw) && !('frame' in raw));
  const [step] = await store.readSteps(SID, 0, 10);
  assert.deepEqual(step.frame, gridRows(3));
  assert.ok(!('anim' in step) && !('anim_z' in step));
});

test('readStep returns the animation by the tail path and by the scan path', async (t) => {
  const { store } = await storeAt(t);
  await newSession(store);
  const a0 = [gridRows(1)];
  const a1 = [gridRows(4), gridRows(5)];
  await store.appendStep(SID, { n: 0, action: 'ACTION1', frame: gridRows(2), anim: a0 });
  await store.appendStep(SID, { n: 1, action: 'ACTION2', frame: gridRows(6), anim: a1 });
  await store.flush();
  assert.deepEqual((await store.readStep(SID, 1)).anim, a1, 'tail path: the last line');
  const scanned = await store.readStep(SID, 0);
  assert.deepEqual(scanned.anim, a0, 'scan path: an earlier line');
  assert.deepEqual(scanned.frame, gridRows(2));
  assert.equal(await store.readStep(SID, 2), null);
  assert.equal(await store.readStep('s-000000000000', 0), null);
});

test('lastFrame is the last frame of the newest step, after an append and after a restart', async (t) => {
  const { env, store } = await storeAt(t);
  await newSession(store);
  await store.appendStep(SID, { n: 0, action: 'A', frame: gridRows(1), anim: [gridRows(9)] });
  assert.deepEqual(store.lastFrame(SID), gridRows(1));
  await store.flush();
  const again = await storeAt(t, env);
  assert.deepEqual(again.store.lastFrame(SID), gridRows(1));
});

test('a last line longer than the tail window still restores lastFrame on init', async (t) => {
  const { env, store, file } = await storeAt(t);
  await newSession(store);
  const anim = Array.from({ length: ANIMATION_FRAMES_MAX - 1 }, noisy);
  await store.appendStep(SID, { n: 0, action: 'A', frame: gridRows(1) });
  // A full animation of random frames is ~190 KB; the padding stands in for a
  // line that outgrows the 256 KiB tail window.
  await store.appendStep(SID, { n: 1, action: 'B', frame: gridRows(2), anim, pad: 'x'.repeat(100 * 1024) });
  await store.flush();
  const last = (await rawLines(file)).at(-1);
  assert.ok(last.length > 256 * 1024, `the line (${last.length} bytes) must exceed the 256 KiB tail window`);
  assert.ok(last.length < 512 * 1024, 'and fit the fallback window');
  const again = await storeAt(t, env);
  assert.deepEqual(again.store.lastFrame(SID), gridRows(2));
  assert.deepEqual((await again.store.readStep(SID, 1)).anim, anim);
});

test('old lines read: plain frame, and frame_z without anim_z (anim is absent, not null)', async (t) => {
  const env = await freshEnv(t);
  const dir = path.join(env.dataDir, 'sessions', SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: SID, status: 'ended', created_at: 'x', step_count: 1 }));
  const z = deepZ(gridRows(2));
  await fs.writeFile(path.join(dir, 'steps.jsonl'), `${JSON.stringify({ n: 0, action: 'A', frame: gridRows(1) })}\n${JSON.stringify({ n: 1, action: 'B', frame_z: z })}\n`);
  const { store } = await storeAt(t, env);
  assert.deepEqual(store.lastFrame(SID), gridRows(2));
  const plain = await store.readStep(SID, 0);
  assert.deepEqual(plain.frame, gridRows(1));
  assert.equal(plain.anim, undefined);
  assert.equal((await store.readStep(SID, 1)).anim, undefined);
  assert.deepEqual((await store.readSteps(SID, 0, 5)).map((s) => s.n), [0, 1]);
});
function deepZ(rows) { return deflateRawSync(rows.join('\n')).toString('base64'); }

test('a corrupt, oversized or invalid anim_z reads as anim: null with the frame intact', async (t) => {
  const env = await freshEnv(t);
  const dir = path.join(env.dataDir, 'sessions', SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: SID, status: 'ended', created_at: 'x', step_count: 3 }));
  const f = gridRows(1);
  const bomb = deflateRawSync(Buffer.alloc(2 * 1024 * 1024, 0x30)).toString('base64');
  const lines = [
    { n: 0, frame_z: deepZ(f), anim_z: 'not base64 deflate' },
    { n: 1, frame_z: deepZ(f), anim_z: bomb },
    { n: 2, frame_z: deepZ(f), anim_z: deepZ(['zz not hex']) },
    { n: 3, frame_z: deepZ(f), anim_z: deflateRawSync(Array(ANIMATION_FRAMES_MAX).fill('11').join('\n\n')).toString('base64') },
  ];
  await fs.writeFile(path.join(dir, 'steps.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const { store } = await storeAt(t, env);
  for (const n of [0, 1, 2, 3]) {
    const s = await store.readStep(SID, n);
    assert.equal(s.anim, null, `step ${n}`);
    assert.deepEqual(s.frame, f, `step ${n} keeps its last frame`);
  }
});

test('frames inside anim_z are separated by a blank line, so rows and frames never mix', async (t) => {
  const { store } = await storeAt(t);
  await newSession(store);
  await store.appendStep(SID, { n: 0, action: 'A', frame: ['00'], anim: [['11', '22'], ['33']] });
  await store.flush();
  assert.deepEqual((await store.readStep(SID, 0)).anim, [['11', '22'], ['33']]);
});
