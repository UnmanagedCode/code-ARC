// One-run sessions (the default; docs/protocol.md → RESET_DISABLED): no resets
// from the tools unless the session was started with allow_reset:true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { json, ok, refusal, startApp, startGame } from './_helpers.mjs';
import { readNet } from './_bundle.mjs';

const FAST = { stepRate: { max: 1000, windowMs: 1000 } };
const resets = async (calls) => (await calls()).filter((c) => c.op === 'reset').length;
const WIN = ['ACTION4', 'ACTION4', 'ACTION4', 'ACTION2', 'ACTION2', 'ACTION2'];

async function win(mcp, sid) {
  let last;
  for (const action of WIN) last = ok(await mcp('act', { session_id: sid, action }));
  return last;
}

const stored = async (env, sid) => JSON.parse(await fs.readFile(path.join(env.dataDir, 'sessions', sid, 'meta.json'), 'utf8'));

test('an omitted allow_reset is one run: stored and surfaced as false; reset refused RESET_DISABLED', async (t) => {
  const { mcp, env, url } = await startApp(t, FAST);
  const start = ok(await mcp('start_session', { game_id: 'fake-lose' }));
  const sid = start.session_id;
  assert.equal(start.allow_reset, false);
  assert.equal((await stored(env, sid)).allow_reset, false);
  assert.equal(ok(await mcp('list_sessions')).sessions.find((s) => s.session_id === sid).allow_reset, false);
  assert.equal((await json(`${url}/api/sessions/${sid}`)).body.allow_reset, false);
  const r = refusal(await mcp('reset', { session_id: sid }), 'RESET_DISABLED');
  assert.equal(r.details.allow_reset, false);
  const over = ok(await mcp('act', { session_id: sid, action: 'ACTION3' }));
  assert.equal(over.state, 'GAME_OVER');
  assert.deepEqual(over.available_actions, []);
});

test('allow_reset:true allows resets: surfaced as true; reset after GAME_OVER continues', async (t) => {
  const { mcp, env, url } = await startApp(t, FAST);
  const start = ok(await mcp('start_session', { game_id: 'fake-lose', allow_reset: true }));
  const sid = start.session_id;
  assert.equal(start.allow_reset, true);
  assert.ok(start.available_actions.length > 0);
  const over = ok(await mcp('act', { session_id: sid, action: 'ACTION3' }));
  assert.equal(over.state, 'GAME_OVER');
  const refused = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'GAME_FINISHED');
  assert.equal('allow_reset' in refused.details, false);
  assert.equal(ok(await mcp('reset', { session_id: sid })).state, 'NOT_FINISHED');
  assert.equal((await stored(env, sid)).allow_reset, true);
  assert.equal(ok(await mcp('list_sessions')).sessions.find((s) => s.session_id === sid).allow_reset, true);
  assert.equal((await json(`${url}/api/sessions/${sid}`)).body.allow_reset, true);
});

test('allow_reset:false refuses every reset (start, level, after a win) without reaching the toolkit or recording a step', async (t) => {
  const { mcp, calls, url } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-maze', { allow_reset: false });
  const baseline = await resets(calls);
  const step = async () => ok(await mcp('observe', { session_id: sid })).step;
  const refused = async () => refusal(await mcp('reset', { session_id: sid }), 'RESET_DISABLED');

  let s0 = await step();
  await refused();
  assert.equal(await step(), s0);
  await mcp('act', { session_id: sid, action: 'ACTION4' });
  s0 = await step();
  const r = await refused();
  assert.equal(r.details.allow_reset, false);
  await mcp('act', { session_id: sid, action: 'ACTION4' });
  await mcp('act', { session_id: sid, action: 'ACTION4' });
  for (const a of WIN.slice(3)) await mcp('act', { session_id: sid, action: a });
  s0 = await step();
  await refused();
  assert.equal(await step(), s0);
  assert.equal(await resets(calls), baseline, 'no reset reached the toolkit');
  const steps = (await json(`${url}/api/sessions/${sid}/steps`)).body.steps;
  assert.equal(steps.some((x) => x.action === 'RESET'), false);
});

test('after GAME_OVER a one-run session is terminal: act refused, no actions offered, end_session closes it', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-lose', { allow_reset: false });
  const over = ok(await mcp('act', { session_id: sid, action: 'ACTION3' }));
  for (const meta of [over, ok(await mcp('observe', { session_id: sid }))]) {
    assert.equal(meta.state, 'GAME_OVER');
    assert.equal(meta.allow_reset, false);
    assert.deepEqual(meta.available_actions, []);
  }
  const refused = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'GAME_FINISHED');
  assert.equal(refused.details.allow_reset, false);
  assert.equal(refused.details.state, 'GAME_OVER');
  assert.doesNotMatch(refused.error, /only reset/);
  const end = ok(await mcp('end_session', { session_id: sid }));
  assert.equal(end.final.state, 'GAME_OVER');
});

test('after a full win a one-run session is terminal too', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-maze', { allow_reset: false });
  const won = await win(mcp, sid);
  assert.equal(won.state, 'WIN');
  assert.deepEqual(won.available_actions, []);
  const refused = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'GAME_FINISHED');
  assert.equal(refused.details.allow_reset, false);
  refusal(await mcp('reset', { session_id: sid }), 'RESET_DISABLED');
});

test('online one-run sessions: refusal is local and spends no rate budget', async (t) => {
  const { mcp, env } = await startApp(t, { ...FAST, onlineRpmLimit: 4 });
  const sid = await startGame(mcp, 'fake-maze', { online: true, allow_reset: false }); // costs 2
  const netBefore = (await readNet(env.dataDir)).length;
  for (let i = 0; i < 5; i++) refusal(await mcp('reset', { session_id: sid }), 'RESET_DISABLED');
  const act = ok(await mcp('act', { session_id: sid, action: 'ACTION4' }));
  assert.ok(act.online);
  const net = (await readNet(env.dataDir)).slice(netBefore);
  assert.equal(net.some((n) => n.path === '/api/cmd/RESET'), false);
});

test('allow_reset must be a boolean', async (t) => {
  const { mcp, app } = await startApp(t);
  refusal(await mcp('start_session', { game_id: 'fake-maze', allow_reset: 'no' }), 'INVALID_ARGUMENT');
  assert.equal((await app.sessions.start({ game_id: 'fake-maze', allow_reset: 'no' }, { sessionId: 'agent-a' })).code, 'INVALID_ARGUMENT');
});

test('list_sessions and api/sessions surface allow_reset either way', async (t) => {
  const { mcp, url } = await startApp(t);
  const sid = await startGame(mcp, 'fake-maze', { allow_reset: false });
  const sidOn = await startGame(mcp, 'fake-maze', { allow_reset: true });
  const sessions = ok(await mcp('list_sessions')).sessions;
  assert.equal(sessions.find((s) => s.session_id === sid).allow_reset, false);
  assert.equal(sessions.find((s) => s.session_id === sidOn).allow_reset, true);
  assert.equal((await json(`${url}/api/sessions/${sid}`)).body.allow_reset, false);
  assert.equal((await json(`${url}/api/sessions/${sidOn}`)).body.allow_reset, true);
});

test('a one-run session never lists RESET while unfinished, even when the toolkit reports it; a resettable session still does', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const oneRun = ok(await mcp('start_session', { game_id: 'fake-reset0', allow_reset: false }));
  assert.equal(oneRun.state, 'NOT_FINISHED');
  assert.deepEqual(oneRun.available_actions, ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6']);
  const refused = refusal(await mcp('act', { session_id: oneRun.session_id, action: 'ACTION5' }), 'ACTION_UNAVAILABLE');
  assert.deepEqual(refused.details.available_actions, ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6']);

  const normal = ok(await mcp('start_session', { game_id: 'fake-reset0', allow_reset: true }));
  assert.ok(normal.available_actions.includes('RESET'));
  const normalRefused = refusal(await mcp('act', { session_id: normal.session_id, action: 'ACTION5' }), 'ACTION_UNAVAILABLE');
  assert.ok(normalRefused.details.available_actions.includes('RESET'));
});
