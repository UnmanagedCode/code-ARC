// The human play routes (src/play.js): a person plays sessions they started in
// the view through the same service as the MCP tools. Each test names the
// invariant it pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, ok, refusal, sendJsonReq, sseCollect, startApp, startGame } from './_helpers.mjs';
import { MAX_LIVE_SESSIONS, SESSION_STEPS_MAX } from '../src/limits.js';

const A = { sessionId: 'agent-a', project: 'proj' };
const NULL = { sessionId: null, project: null };
const fakeClock = (start = Date.parse('2026-01-01T00:00:00Z')) => {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
};
const manualTimers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };
const play = (url, path, body, headers) => sendJsonReq(url + path, 'POST', body, headers);
const stepsOf = async (url, sid) => (await json(`${url}/api/sessions/${sid}/steps`)).body.steps;
const toolkitSteps = async (calls) => (await calls()).filter((c) => c.op === 'step' || c.op === 'reset').length;

async function humanStart(url, extra = {}, game = 'fake-maze') {
  const r = await play(url, '/api/sessions', { game_id: game, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.session_id;
}

// Pins: GET api/games is exactly list_games' json data (one source, no copy).
test('api/games equals the list_games tool data', async (t) => {
  const { url, mcp } = await startApp(t);
  const r = await json(`${url}/api/games`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, ok(await mcp('list_games')));
});

// Pins: a human session is owned {kind:'human'}, its steps are recorded
// source:'human' with coordinates reaching the toolkit, and the 200 body is the
// observation without a frame.
test('a person starts, acts (with coordinates), resets; steps are human', async (t) => {
  const { url, app, calls } = await startApp(t);
  const started = await play(url, '/api/sessions', { game_id: 'fake-maze', max_resets: 1 });
  assert.equal(started.status, 200);
  const sid = started.body.session_id;
  assert.deepEqual(app.store.get(sid).owner, { kind: 'human', sessionId: null, project: null });
  assert.equal(started.body.title, 'Fake Maze');
  assert.equal('frame' in started.body, false);
  assert.equal('ok' in started.body, false);
  assert.ok(started.body.available_actions.includes('ACTION4'));

  assert.equal((await play(url, `/api/sessions/${sid}/act`, { action: 'ACTION4' })).status, 200);
  const clicked = await play(url, `/api/sessions/${sid}/act`, { action: 'ACTION6', x: 10, y: 20 });
  assert.equal(clicked.status, 200);
  assert.equal(clicked.body.step, 2);
  assert.equal((await play(url, `/api/sessions/${sid}/reset`, {})).status, 200);

  const steps = await stepsOf(url, sid);
  assert.deepEqual(steps.map((s) => [s.action, s.source]), [['START', 'human'], ['ACTION4', 'human'], ['ACTION6', 'human'], ['RESET', 'human']]);
  assert.deepEqual([steps[2].x, steps[2].y], [10, 20]);
  const sent = (await calls()).find((c) => c.op === 'step' && c.action === 'ACTION6');
  assert.ok(sent, JSON.stringify(await calls()));
  assert.deepEqual(sent.data, { x: 10, y: 20 });
});

// Pins: the live SSE step event carries source:'human', as the stored step does.
test('the SSE step event of a human act carries source human', async (t) => {
  const { url } = await startApp(t);
  const sid = await humanStart(url);
  let acted = false;
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'step' && e.data.step.n === 1), {
    onEvent: async (ev) => {
      if (ev.event !== 'sessions' || acted) return;
      acted = true;
      await play(url, `/api/sessions/${sid}/act`, { action: 'ACTION1' });
    },
  });
  assert.equal(events.find((e) => e.event === 'step' && e.data.step.n === 1).data.step.source, 'human');
});

// Pins: ending from the view records ended_by_user, returns the end body, and
// later calls see the session as ended.
test('end records ended_by_user; the session is then ended', async (t) => {
  const { url, app } = await startApp(t);
  const sid = await humanStart(url);
  const r = await play(url, `/api/sessions/${sid}/end`, {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.session_id, r.body.steps, 'ok' in r.body], [sid, 0, false]);
  assert.equal(app.store.get(sid).end_reason, 'ended_by_user');
  const again = await play(url, `/api/sessions/${sid}/act`, { action: 'ACTION1' });
  assert.deepEqual([again.status, again.body.code], [409, 'SESSION_ENDED']);
});

// Pins: input is validated before anything reaches the toolkit; only each
// route's own keys are accepted (no reasoning, frame, session_id).
test('invalid bodies and ids are refused before the toolkit is called', async (t) => {
  const { url, calls } = await startApp(t);
  const sid = await humanStart(url, { max_resets: 1 });
  const before = await toolkitSteps(calls);
  const bad = async (path, body, status, code) => {
    const r = await play(url, path, body);
    assert.deepEqual([r.status, r.body.code], [status, code], `${path} ${JSON.stringify(body)}`);
  };
  const act = `/api/sessions/${sid}/act`;
  for (const extra of [{ reasoning: 'x' }, { frame: 'full' }, { session_id: sid }]) await bad(act, { action: 'ACTION1', ...extra }, 400, 'INVALID_ARGUMENT');
  await bad(act, { action: 'ACTION6' }, 400, 'INVALID_ARGUMENT');
  await bad(act, { action: 'ACTION6', x: 64, y: 0 }, 400, 'INVALID_ARGUMENT');
  await bad(act, { action: 'RESET' }, 400, 'INVALID_ARGUMENT');
  await bad(act, { action: 'ACTION1', x: 1, y: 1 }, 400, 'INVALID_ARGUMENT');
  await bad(`/api/sessions/${sid}/reset`, { reasoning: 'x' }, 400, 'INVALID_ARGUMENT');
  await bad(`/api/sessions/${sid}/end`, { x: 1 }, 400, 'INVALID_ARGUMENT');
  await bad('/api/sessions', { game_id: 'bad id!' }, 400, 'INVALID_ARGUMENT');
  await bad('/api/sessions', { game_id: 'fake-maze', reasoning: 'x' }, 400, 'INVALID_ARGUMENT');
  await bad('/api/sessions', {}, 400, 'INVALID_ARGUMENT');
  await bad('/api/sessions', { game_id: 'fake-maze', allow_reset: true }, 400, 'INVALID_ARGUMENT');
  await bad('/api/sessions', { game_id: 'fake-maze', max_resets: -1 }, 400, 'INVALID_ARGUMENT');
  await bad('/api/sessions', { game_id: 'fake-maze', max_resets: 1.5 }, 400, 'INVALID_ARGUMENT');
  await bad('/api/sessions/s-nope/act', { action: 'ACTION1' }, 404, 'SESSION_UNKNOWN');
  await bad('/api/sessions/s-ffffffffffff/act', { action: 'ACTION1' }, 404, 'SESSION_UNKNOWN');
  await bad('/api/sessions/s-ffffffffffff/end', {}, 404, 'SESSION_UNKNOWN');
  await bad('/api/sessions', { game_id: 'no-such-game' }, 400, 'GAME_UNKNOWN');
  assert.equal(await toolkitSteps(calls), before);
  assert.equal((await json(`${url}${act}`)).status, 405);
  assert.equal((await fetch(`${url}${act}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
});

// Pins: the same-origin JSON guard covers every play route, and a guarded
// request starts and records nothing.
test('guards: content type, Sec-Fetch-Site and Origin refuse before any effect', async (t) => {
  const { url, app, calls } = await startApp(t);
  const sid = await humanStart(url);
  const sessions = app.store.list().length;
  const before = await toolkitSteps(calls);
  const routes = [['/api/sessions', { game_id: 'fake-maze' }], [`/api/sessions/${sid}/act`, { action: 'ACTION1' }], [`/api/sessions/${sid}/reset`, {}], [`/api/sessions/${sid}/end`, {}]];
  for (const [path, body] of routes) {
    const text = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    assert.equal(text.status, 415, path);
    for (const site of ['cross-site', 'same-site']) assert.equal((await play(url, path, body, { 'sec-fetch-site': site })).status, 403, `${path} ${site}`);
    assert.equal((await play(url, path, body, { origin: 'http://evil.example' })).status, 403, path);
  }
  assert.equal(app.store.list().length, sessions);
  assert.equal(app.store.get(sid).step_count, 0);
  assert.equal(await toolkitSteps(calls), before);
});

// Pins: the view never acts on an agent's session, however it was owned
// (named agent, anonymous agent, legacy meta without owner.kind).
test('HTTP play on agent sessions is refused AGENT_SESSION and changes nothing', async (t) => {
  const { url, app, mcp } = await startApp(t);
  const named = await startGame(mcp, 'fake-maze', { max_resets: 1 }, A);
  const anon = await startGame(mcp, 'fake-maze', { max_resets: 1 }, NULL);
  const legacy = 's-aaaaaaaaaaaa';
  const at = '2026-01-01T00:00:00.000Z';
  await app.store.create({
    id: legacy, game_id: 'fake-maze', title: 'Fake Maze', mode: 'local', max_resets: null, resets_used: 0, at_level_start: false, owner: { sessionId: 'agent-old', project: 'proj' }, scorecard_id: 'c', scorecard_url: null,
    status: 'live', end_reason: null, stalled: false, created_at: at, updated_at: at, last_activity_at: at, step_count: 0,
    last: { state: 'NOT_FINISHED', levels_completed: 0, win_levels: 3, available_actions: [1, 2, 3, 4], frame_count: 1, full_reset: false },
  });
  for (const sid of [named, anon, legacy]) {
    const steps = app.store.get(sid).step_count;
    for (const [path, body] of [['act', { action: 'ACTION1' }], ['reset', {}], ['end', {}]]) {
      const r = await play(url, `/api/sessions/${sid}/${path}`, body);
      assert.deepEqual([r.status, r.body.code], [403, 'AGENT_SESSION'], `${sid} ${path}`);
    }
    assert.equal(app.store.get(sid).step_count, steps);
    assert.equal(app.store.get(sid).status, 'live');
  }
});

// Pins: an agent (either format, any caller, even one claiming source:'human')
// never acts on, notes on or ends a human session; it can observe and list it,
// and it is never one of the agent's own.
test('agents are refused HUMAN_SESSION on a human session but can observe and list it', async (t) => {
  const { url, app, mcp, mcpText } = await startApp(t);
  const sid = await humanStart(url, { max_resets: 1 });
  const steps = app.store.get(sid).step_count;
  const calls = [['act', { session_id: sid, action: 'ACTION1' }], ['reset', { session_id: sid }], ['end_session', { session_id: sid }], ['note', { session_id: sid, note: 'n' }]];
  for (const caller of [A, NULL]) {
    for (const [tool, args] of calls) {
      const j = refusal(await mcp(tool, args, caller), 'HUMAN_SESSION');
      assert.deepEqual(refusal(await mcpText(tool, args, caller), 'HUMAN_SESSION'), j, tool);
      assert.match(j.error, /observe/);
    }
  }
  for (const [tool, args] of calls) {
    refusal(await app.mcp.handle({ tool, arguments: args, caller: { ...A, source: 'human' }, format: 'json' }), 'HUMAN_SESSION');
  }
  assert.equal(app.store.get(sid).step_count, steps);
  assert.equal(app.store.get(sid).status, 'live');
  assert.equal(ok(await mcp('observe', { session_id: sid }, A)).session_id, sid);

  for (const caller of [A, NULL]) assert.equal(ok(await mcp('list_sessions', { scope: 'mine' }, caller)).total, 0);
  const all = ok(await mcp('list_sessions', { scope: 'all' }, A));
  assert.deepEqual(all.sessions[0].owner, { kind: 'human', sessionId: null, project: null });
  assert.match((await mcpText('list_sessions', { scope: 'all' }, A)).text, /owner human/);
  const agent = await startGame(mcp, 'fake-maze', {}, A);
  const mine = ok(await mcp('list_sessions', { scope: 'mine' }, A));
  assert.deepEqual(mine.sessions.map((s) => [s.session_id, s.owner.kind]), [[agent, 'agent']]);
});

// Pins: view play is bound by the service's limits: the shared live cap, the
// step rate, the step cap, one-run resets, available actions, finished games.
test('limits apply to view play: live cap shared with MCP', async (t) => {
  const { url, mcp } = await startApp(t);
  for (let i = 0; i < MAX_LIVE_SESSIONS - 1; i++) await startGame(mcp, 'fake-maze', {}, A);
  await humanStart(url);
  const http = await play(url, '/api/sessions', { game_id: 'fake-maze' });
  assert.deepEqual([http.status, http.body.code], [409, 'TOO_MANY_SESSIONS']);
  refusal(await mcp('start_session', { game_id: 'fake-maze' }, A), 'TOO_MANY_SESSIONS');
});

test('limits apply to view play: step rate, step cap, one-run reset, actions, finished game', async (t) => {
  const clock = fakeClock();
  const { url, app, calls } = await startApp(t, { clock, timers: manualTimers, stepRate: { max: 1, windowMs: 60000 } });
  const sid = await humanStart(url);
  assert.equal((await play(url, `/api/sessions/${sid}/act`, { action: 'ACTION1' })).status, 200);
  const limited = await play(url, `/api/sessions/${sid}/act`, { action: 'ACTION1' });
  assert.deepEqual([limited.status, limited.body.code], [429, 'STEP_RATE_LIMITED']);
  assert.ok(limited.body.details.retry_after_ms > 0);
  clock.advance(60000);

  await app.store.update(sid, { step_count: SESSION_STEPS_MAX });
  const capped = await play(url, `/api/sessions/${sid}/act`, { action: 'ACTION1' });
  assert.deepEqual([capped.status, capped.body.code], [409, 'SESSION_STEP_LIMIT']);
  await app.store.update(sid, { step_count: 1 });

  const resets = (await calls()).filter((c) => c.op === 'reset').length;
  const noReset = await play(url, `/api/sessions/${sid}/reset`, {});
  assert.deepEqual([noReset.status, noReset.body.code], [409, 'RESET_LIMIT']);
  assert.equal((await calls()).filter((c) => c.op === 'reset').length, resets, 'no reset reached the toolkit');

  const unavailable = await play(url, `/api/sessions/${sid}/act`, { action: 'ACTION5' });
  assert.deepEqual([unavailable.status, unavailable.body.code], [409, 'ACTION_UNAVAILABLE']);

  const lose = await humanStart(url, {}, 'fake-lose');
  assert.equal((await play(url, `/api/sessions/${lose}/act`, { action: 'ACTION3' })).body.state, 'GAME_OVER');
  const done = await play(url, `/api/sessions/${lose}/act`, { action: 'ACTION1' });
  assert.deepEqual([done.status, done.body.code], [409, 'GAME_FINISHED']);
});

// Pins: the local ONLINE rate guard applies to view play (429 RATE_LIMITED).
test('limits apply to view play: online rate guard', async (t) => {
  const clock = fakeClock();
  const { url } = await startApp(t, { clock, timers: manualTimers, onlineRpmLimit: 2 });
  await humanStart(url, { online: true }); // costs 2
  const r = await play(url, '/api/sessions', { game_id: 'fake-maze', online: true });
  assert.deepEqual([r.status, r.body.code], [429, 'RATE_LIMITED']);
  assert.ok(r.body.details.retry_after_ms > 0);
});

// Pins: a live human session blocks an API key change like any live session.
test('a live human session blocks an API key change', async (t) => {
  const { url } = await startApp(t);
  await humanStart(url);
  const r = await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: 'abcdefghijklmnop' });
  assert.deepEqual([r.status, r.body.code], [409, 'SESSIONS_ACTIVE']);
});

// Pins: GET api/games has side effects (sidecar, arcprize.org), so a cross-site
// request is refused before any toolkit call; the view's own same-origin fetch passes.
test('GET api/games refuses cross-site requests without touching the toolkit', async (t) => {
  const { url, calls, app } = await startApp(t);
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'http://evil.example' }]) {
    const r = await json(`${url}/api/games`, { headers });
    assert.deepEqual([r.status, r.body.code], [403, 'CROSS_SITE'], JSON.stringify(headers));
  }
  assert.deepEqual(await calls(), []);
  assert.equal(app.sidecar.status().running, false);
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
    assert.equal((await json(`${url}/api/games`, { headers })).status, 200, JSON.stringify(headers));
  }
});
