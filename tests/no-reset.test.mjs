// allow_reset:false sessions (docs/protocol.md → RESET_DISABLED): one run, no
// resets, from the tools and from the script API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { json, sendJsonReq, startApp, startGame } from './_helpers.mjs';
import { readNet } from './_bundle.mjs';

const FAST = { stepRate: { max: 1000, windowMs: 1000 } };
const resets = async (calls) => (await calls()).filter((c) => c.op === 'reset').length;
const WIN = ['ACTION4', 'ACTION4', 'ACTION4', 'ACTION2', 'ACTION2', 'ACTION2'];

async function win(mcp, sid) {
  let last;
  for (const action of WIN) last = await mcp('act', { session_id: sid, action });
  return last;
}

test('default sessions are unchanged: no allow_reset key anywhere; reset after GAME_OVER continues', async (t) => {
  const { mcp, env } = await startApp(t, FAST);
  const start = await mcp('start_session', { game_id: 'fake-lose' });
  const sid = start.meta.session_id;
  assert.equal('allow_reset' in start.meta, false);
  assert.ok(start.meta.available_actions.length > 0);
  const over = await mcp('act', { session_id: sid, action: 'ACTION3' });
  assert.equal(over.meta.state, 'GAME_OVER');
  const refused = (await mcp('act', { session_id: sid, action: 'ACTION1' })).result;
  assert.equal(refused.code, 'GAME_FINISHED');
  assert.equal('allow_reset' in refused, false);
  assert.equal((await mcp('reset', { session_id: sid })).meta.state, 'NOT_FINISHED');
  const stored = JSON.parse(await fs.readFile(path.join(env.dataDir, 'sessions', sid, 'meta.json'), 'utf8'));
  assert.equal('allow_reset' in stored, false);
  const listed = (await mcp('list_sessions')).result.sessions.find((s) => s.session_id === sid);
  assert.equal('allow_reset' in listed, false);
});

test('allow_reset:false refuses every reset (start, level, after a win) without reaching the toolkit or recording a step', async (t) => {
  const { mcp, calls, url } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-maze', { allow_reset: false });
  const baseline = await resets(calls);
  const step = async () => (await mcp('observe', { session_id: sid })).meta.step;
  const refused = async () => (await mcp('reset', { session_id: sid })).result;

  let s0 = await step();
  assert.equal((await refused()).code, 'RESET_DISABLED');
  assert.equal(await step(), s0);
  await mcp('act', { session_id: sid, action: 'ACTION4' });
  s0 = await step();
  const r = await refused();
  assert.equal(r.code, 'RESET_DISABLED');
  assert.equal(r.allow_reset, false);
  await mcp('act', { session_id: sid, action: 'ACTION4' });
  await mcp('act', { session_id: sid, action: 'ACTION4' });
  for (const a of WIN.slice(3)) await mcp('act', { session_id: sid, action: a });
  s0 = await step();
  assert.equal((await refused()).code, 'RESET_DISABLED');
  assert.equal(await step(), s0);
  assert.equal(await resets(calls), baseline, 'no reset reached the toolkit');
  const steps = (await json(`${url}/api/sessions/${sid}/steps`)).body.steps;
  assert.equal(steps.some((x) => x.action === 'RESET'), false);
});

test('after GAME_OVER a one-run session is terminal: act refused, no actions offered, end_session closes it', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-lose', { allow_reset: false });
  const over = await mcp('act', { session_id: sid, action: 'ACTION3' });
  for (const meta of [over.meta, (await mcp('observe', { session_id: sid })).meta]) {
    assert.equal(meta.state, 'GAME_OVER');
    assert.equal(meta.allow_reset, false);
    assert.deepEqual(meta.available_actions, []);
  }
  const refused = (await mcp('act', { session_id: sid, action: 'ACTION1' })).result;
  assert.equal(refused.code, 'GAME_FINISHED');
  assert.equal(refused.allow_reset, false);
  assert.equal(refused.state, 'GAME_OVER');
  assert.doesNotMatch(refused.reason, /only reset/);
  const end = (await mcp('end_session', { session_id: sid })).result;
  assert.equal(end.ok, true);
  assert.equal(end.final.state, 'GAME_OVER');
});

test('after a full win a one-run session is terminal too', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-maze', { allow_reset: false });
  const won = await win(mcp, sid);
  assert.equal(won.meta.state, 'WIN');
  assert.deepEqual(won.meta.available_actions, []);
  const refused = (await mcp('act', { session_id: sid, action: 'ACTION1' })).result;
  assert.equal(refused.code, 'GAME_FINISHED');
  assert.equal(refused.allow_reset, false);
  assert.equal((await mcp('reset', { session_id: sid })).result.code, 'RESET_DISABLED');
});

test('the script route refuses reset the same way', async (t) => {
  const { mcp, calls } = await startApp(t, FAST);
  const start = await mcp('start_session', { game_id: 'fake-maze', allow_reset: false });
  const { base_url: base, token } = start.meta.script;
  const headers = { authorization: `Bearer ${token}` };
  const attach = await sendJsonReq(`${base}attach`, 'POST', { note: 'one run' }, headers);
  assert.equal(attach.body.allow_reset, false);
  const before = await resets(calls);
  const r = await sendJsonReq(`${base}reset`, 'POST', { run: attach.body.run }, headers);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'RESET_DISABLED');
  assert.equal(await resets(calls), before);
});

test('online one-run sessions: refusal is local and spends no rate budget', async (t) => {
  const { mcp, env } = await startApp(t, { ...FAST, onlineRpmLimit: 4 });
  const sid = await startGame(mcp, 'fake-maze', { online: true, allow_reset: false }); // costs 2
  const netBefore = (await readNet(env.dataDir)).length;
  for (let i = 0; i < 5; i++) assert.equal((await mcp('reset', { session_id: sid })).result.code, 'RESET_DISABLED');
  const act = await mcp('act', { session_id: sid, action: 'ACTION4' });
  assert.ok(act.meta.online);
  const net = (await readNet(env.dataDir)).slice(netBefore);
  assert.equal(net.some((n) => n.path === '/api/cmd/RESET'), false);
});

test('allow_reset must be a boolean', async (t) => {
  const { mcp, app } = await startApp(t);
  assert.equal((await mcp('start_session', { game_id: 'fake-maze', allow_reset: 'no' })).result.code, 'INVALID_ARGUMENT');
  assert.equal((await app.sessions.start({ game_id: 'fake-maze', allow_reset: 'no' }, { sessionId: 'agent-a' })).code, 'INVALID_ARGUMENT');
});

test('list_sessions and api/sessions surface allow_reset:false', async (t) => {
  const { mcp, url } = await startApp(t);
  const sid = await startGame(mcp, 'fake-maze', { allow_reset: false });
  const listed = (await mcp('list_sessions')).result.sessions.find((s) => s.session_id === sid);
  assert.equal(listed.allow_reset, false);
  assert.equal((await json(`${url}/api/sessions/${sid}`)).body.allow_reset, false);
});
