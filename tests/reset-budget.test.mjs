// The reset budget (docs/protocol.md → RESET_LIMIT, RESET_UNNEEDED): a session
// may make `max_resets` level resets (default 0 = one run); a won game is
// never replayed, and a reset before any move on the level is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { json, ok, refusal, startApp, startGame, until } from './_helpers.mjs';
import { readNet } from './_bundle.mjs';
import { DEADLINES } from '../src/limits.js';

const FAST = { stepRate: { max: 1000, windowMs: 1000 } };
const resets = async (calls) => (await calls()).filter((c) => c.op === 'reset').length;
const WIN = ['ACTION4', 'ACTION4', 'ACTION4', 'ACTION2', 'ACTION2', 'ACTION2'];
const move = async (mcp, sid, action = 'ACTION1') => ok(await mcp('act', { session_id: sid, action }));
const reset = async (mcp, sid) => ok(await mcp('reset', { session_id: sid }));
const stored = async (env, sid) => JSON.parse(await fs.readFile(path.join(env.dataDir, 'sessions', sid, 'meta.json'), 'utf8'));
const observe = async (mcp, sid) => ok(await mcp('observe', { session_id: sid }));

async function win(mcp, sid) {
  let last;
  for (const action of WIN) last = await move(mcp, sid, action);
  return last;
}

test('an omitted max_resets is 0: stored and surfaced everywhere; reset refused RESET_LIMIT without reaching the toolkit', async (t) => {
  const { mcp, env, url, calls } = await startApp(t, FAST);
  const start = ok(await mcp('start_session', { game_id: 'fake-maze' }));
  const sid = start.session_id;
  assert.deepEqual([start.max_resets, start.resets_used, start.resets_remaining], [0, 0, 0]);
  const meta = await stored(env, sid);
  assert.deepEqual([meta.max_resets, meta.resets_used, 'allow_reset' in meta], [0, 0, false]);
  const listed = ok(await mcp('list_sessions')).sessions.find((s) => s.session_id === sid);
  assert.deepEqual([listed.max_resets, listed.resets_used], [0, 0]);
  const api = (await json(`${url}/api/sessions/${sid}`)).body;
  assert.deepEqual([api.max_resets, api.resets_used], [0, 0]);
  await move(mcp, sid);
  const step = (await observe(mcp, sid)).step;
  const r = refusal(await mcp('reset', { session_id: sid }), 'RESET_LIMIT');
  assert.deepEqual(r.details, { max_resets: 0, resets_used: 0 });
  assert.match(r.error, /allows no resets/);
  assert.equal((await observe(mcp, sid)).step, step);
  assert.equal(await resets(calls), 1, 'only the START reset reached the toolkit');
});

test('each admitted reset spends one: counted in the meta, the limit refuses the next, levels kept, no full reset', async (t) => {
  const { mcp, env, calls } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-maze', { max_resets: 2 });
  await move(mcp, sid, 'ACTION4');
  const a = await reset(mcp, sid);
  assert.deepEqual([a.resets_used, a.resets_remaining, a.full_reset], [1, 1, false]);
  assert.equal((await stored(env, sid)).resets_used, 1);
  await move(mcp, sid);
  const b = await reset(mcp, sid);
  assert.deepEqual([b.resets_used, b.resets_remaining, b.full_reset], [2, 0, false]);
  await move(mcp, sid);
  const r = refusal(await mcp('reset', { session_id: sid }), 'RESET_LIMIT');
  assert.deepEqual(r.details, { max_resets: 2, resets_used: 2 });
  assert.match(r.error, /resets_used 2 of max_resets 2/);
  assert.equal(await resets(calls), 3, 'START plus two resets');
});

test('an exhausted budget hides RESET from available_actions (also in ACTION_UNAVAILABLE details)', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = (await mcp('start_session', { game_id: 'fake-reset0', max_resets: 1 })).structured.session_id;
  assert.ok((await move(mcp, sid)).available_actions.includes('RESET'));
  await reset(mcp, sid);
  const after = await move(mcp, sid);
  assert.equal(after.available_actions.includes('RESET'), false);
  const refused = refusal(await mcp('act', { session_id: sid, action: 'ACTION5' }), 'ACTION_UNAVAILABLE');
  assert.equal(refused.details.available_actions.includes('RESET'), false);
});

test('RESET_UNNEEDED before any move on a level (after START, after a RESET, after a level-up): no budget, no toolkit call, no step; then a move admits it as a level reset', async (t) => {
  const { mcp, calls } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-maze', { max_resets: 5 });
  const unneeded = async (label) => {
    const before = [await resets(calls), (await observe(mcp, sid)).step];
    const r = refusal(await mcp('reset', { session_id: sid }), 'RESET_UNNEEDED');
    assert.equal(r.details.state, 'NOT_FINISHED', label);
    const o = await observe(mcp, sid);
    assert.deepEqual([await resets(calls), o.step, o.resets_used], [...before, o.resets_used], label);
    return o;
  };
  assert.equal((await unneeded('start')).resets_used, 0);
  await move(mcp, sid);
  await reset(mcp, sid);
  assert.equal((await unneeded('after reset')).resets_used, 1);
  for (const a of ['ACTION4', 'ACTION4', 'ACTION4']) await move(mcp, sid, a);
  assert.equal((await observe(mcp, sid)).levels_completed, 1);
  assert.equal((await unneeded('after level-up')).resets_used, 1);
  await move(mcp, sid);
  const level = await reset(mcp, sid);
  assert.deepEqual([level.levels_completed, level.full_reset, level.resets_used], [1, false, 2]);
});

test('RESET is not offered where a reset would be refused RESET_UNNEEDED', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const start = ok(await mcp('start_session', { game_id: 'fake-reset0', max_resets: 3 }));
  const sid = start.session_id;
  assert.equal(start.available_actions.includes('RESET'), false);
  await move(mcp, sid);
  const reseted = await reset(mcp, sid);
  assert.equal(reseted.available_actions.includes('RESET'), false);
  for (const a of ['ACTION4', 'ACTION4']) await move(mcp, sid, a);
  const up = await move(mcp, sid, 'ACTION4');
  assert.equal(up.levels_completed, 1);
  assert.equal(up.available_actions.includes('RESET'), false);
  assert.ok((await move(mcp, sid)).available_actions.includes('RESET'));
});

test('a won game is never replayed: reset GAME_FINISHED, no toolkit call, no budget spent, nothing offered; act names end_session', async (t) => {
  const { mcp, calls } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-maze', { max_resets: 5 });
  const won = await win(mcp, sid);
  assert.equal(won.state, 'WIN');
  assert.deepEqual(won.available_actions, []);
  const before = await resets(calls);
  const r = refusal(await mcp('reset', { session_id: sid }), 'GAME_FINISHED');
  assert.deepEqual(r.details, { state: 'WIN' });
  assert.equal(await resets(calls), before);
  assert.equal((await observe(mcp, sid)).resets_used, 0);
  const a = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'GAME_FINISHED');
  assert.match(a.error, /end_session/);
});

test('GAME_OVER with budget: reset continues, and the spent budget turns act and reset into terminal refusals', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-lose', { max_resets: 1 });
  const over = await move(mcp, sid, 'ACTION3');
  assert.deepEqual([over.state, over.available_actions], ['GAME_OVER', []]);
  const a = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'GAME_FINISHED');
  assert.equal(a.details.resets_remaining, 1);
  assert.match(a.error, /reset \(resets_remaining 1\) or end_session/);
  const back = await reset(mcp, sid);
  assert.deepEqual([back.state, back.resets_used], ['NOT_FINISHED', 1]);
  assert.equal((await move(mcp, sid, 'ACTION3')).state, 'GAME_OVER');
  refusal(await mcp('reset', { session_id: sid }), 'RESET_LIMIT');
  const done = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'GAME_FINISHED');
  assert.equal(done.details.resets_remaining, 0);
  assert.match(done.error, /the run is over; call end_session/);
  assert.equal(ok(await mcp('end_session', { session_id: sid })).final.state, 'GAME_OVER');
});

test('online: refused resets are local and spend no rate budget', async (t) => {
  const { mcp, env } = await startApp(t, { ...FAST, onlineRpmLimit: 4 });
  const sid = await startGame(mcp, 'fake-maze', { online: true }); // costs 2
  const netBefore = (await readNet(env.dataDir)).length;
  for (let i = 0; i < 5; i++) refusal(await mcp('reset', { session_id: sid }), 'RESET_LIMIT');
  const act = ok(await mcp('act', { session_id: sid, action: 'ACTION4' }));
  assert.ok(act.online);
  const net = (await readNet(env.dataDir)).slice(netBefore);
  assert.equal(net.some((n) => n.path === '/api/cmd/RESET'), false);
});

test('a reset that times out does not count; its late reply, once applied, does', async (t) => {
  const { mcp, app } = await startApp(t, { deadlines: { ...DEADLINES, step: 150, reset: 150 } });
  const sid = await startGame(mcp, 'fake-slow', { max_resets: 2 });
  refusal(await mcp('act', { session_id: sid, action: 'ACTION4' }), 'TOOLKIT_TIMEOUT');
  await until(() => app.store.get(sid).stalled === false);
  assert.equal(app.store.get(sid).resets_used, 0);
  refusal(await mcp('reset', { session_id: sid }), 'TOOLKIT_TIMEOUT');
  assert.equal(app.store.get(sid).resets_used, 0, 'not counted while stalled');
  await until(() => app.store.get(sid).stalled === false);
  assert.equal(app.store.get(sid).resets_used, 1, 'counted when the late reply is applied');
  assert.equal(app.store.get(sid).at_level_start, true);
});

test('a toolkit failure on reset (ONLINE network down) leaves resets_used unchanged', async (t) => {
  const { mcp, app, env } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-maze', { online: true, max_resets: 2 });
  await move(mcp, sid);
  await fs.writeFile(path.join(env.dataDir, 'toolkit', 'fake-net-down'), '');
  const r = await mcp('reset', { session_id: sid });
  assert.equal(r.structured, undefined, JSON.stringify(r));
  assert.equal(app.store.get(sid).resets_used, 0);
});

test('max_resets must be an integer >= 0; allow_reset is an unknown argument', async (t) => {
  const { mcp, app } = await startApp(t);
  for (const bad of [-1, 1.5, '2', true, null]) {
    refusal(await mcp('start_session', { game_id: 'fake-maze', max_resets: bad }), 'INVALID_ARGUMENT');
    assert.equal((await app.sessions.start({ game_id: 'fake-maze', max_resets: bad }, { sessionId: 'agent-a' })).code, 'INVALID_ARGUMENT', String(bad));
  }
  refusal(await mcp('start_session', { game_id: 'fake-maze', allow_reset: true }), 'INVALID_ARGUMENT');
});
