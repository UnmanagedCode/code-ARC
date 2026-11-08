// The script HTTP API: golden path, run semantics, auth and guard, ownership,
// token rotation and lifetime, limits, and token secrecy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { freshEnv, json, ok, refusal, sendJsonReq, sseCollect, startApp, until } from './_helpers.mjs';
import { ONLINE_IDLE_CLOSE_MS } from '../src/online.js';
import { BODY_MAX_BYTES, DEADLINES, NOTE_MAX_CHARS, NOTES_MAX, SESSION_STEPS_MAX, STEP_RATE_MAX, STEP_RATE_WINDOW_MS } from '../src/limits.js';

const A = { sessionId: 'agent-a', project: 'proj' };
const B = { sessionId: 'agent-b', project: 'other' };
const fakeClock = (start = Date.parse('2026-01-01T00:00:00Z')) => {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
};
const manualTimers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };

// POSTs a script op the way the Python client does: JSON, bearer, no Origin.
async function play(base, op, body, { token, headers = {}, raw } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token !== undefined) h.authorization = `Bearer ${token}`;
  return json(`${base}${op}`, { method: 'POST', headers: h, body: raw ?? JSON.stringify(body) });
}

// Starts a game and returns its id and script block.
async function scripted(mcp, extra = {}, caller = A) {
  const r = await mcp('start_session', { game_id: 'fake-maze', ...extra }, caller);
  const s = ok(r);
  return { sid: s.session_id, script: s.script };
}

const ended = (app, sid) => app.store.get(sid).status === 'ended';

test('per-session entries are pruned when a session ends, by every path', async (t) => {
  const clock = fakeClock();
  const { app, mcp } = await startApp(t, { clock, timers: manualTimers, deadlines: { ...DEADLINES, step: 150 } });
  const counts = () => app.sessions._entryCounts();
  const zero = { runtime: 0, tokens: 0 };

  // end_session, after script and tool steps.
  const a = await scripted(mcp);
  await play(a.script.base_url, 'attach', { note: 'n' }, { token: a.script.token });
  await play(a.script.base_url, 'act', { run: 1, action: 'ACTION1' }, { token: a.script.token });
  assert.deepEqual(counts(), { runtime: 1, tokens: 1 });
  await mcp('end_session', { session_id: a.sid });
  assert.deepEqual(counts(), zero);
  assert.equal((await play(a.script.base_url, 'observe', {}, { token: a.script.token })).body.code, 'SESSION_ENDED');
  assert.deepEqual(counts(), zero, 'a refused call re-creates nothing');

  // SCORECARD_CLOSED.
  const closed = await scripted(mcp, { game_id: 'fake-closed', online: true });
  refusal(await mcp('act', { session_id: closed.sid, action: 'ACTION1' }), 'SCORECARD_CLOSED');
  assert.deepEqual(counts(), zero);

  // Idle sweep.
  const idle = await scripted(mcp, { online: true });
  await mcp('act', { session_id: idle.sid, action: 'ACTION1' });
  clock.advance(ONLINE_IDLE_CLOSE_MS);
  await app.sessions.sweep();
  assert.ok(ended(app, idle.sid));
  assert.deepEqual(counts(), zero);

  // A late reply to a session ended meanwhile.
  let lateSeen = false;
  const call = app.sidecar.call;
  app.sidecar.call = (op, args, o = {}) => call(op, args, o.onLate ? { ...o, onLate: (r) => { o.onLate(r); lateSeen = true; } } : o);
  const slow = await scripted(mcp, { game_id: 'fake-slow' });
  refusal(await mcp('act', { session_id: slow.sid, action: 'ACTION1' }), 'TOOLKIT_TIMEOUT');
  await mcp('end_session', { session_id: slow.sid });
  await until(() => lateSeen);
  assert.deepEqual(counts(), zero);
  assert.equal(app.store.get(slow.sid).step_count, 0, 'the late step is not recorded on the ended session');

  // Sidecar exit ends every live session.
  const other = await scripted(mcp);
  const crash = await scripted(mcp, { game_id: 'fake-crash' });
  refusal(await mcp('act', { session_id: crash.sid, action: 'ACTION1' }), 'SIDECAR_EXITED');
  await until(() => ended(app, other.sid) && ended(app, crash.sid));
  assert.deepEqual(counts(), zero);
});

const stepCalls = async (calls) => (await calls()).filter((c) => c.op === 'step' || c.op === 'reset').length;

test('golden path: start carries the script block; attach, act; steps and notes are tagged and announced', async (t) => {
  const { url, mcp } = await startApp(t);
  const { sid, script } = await scripted(mcp);
  assert.equal(script.base_url, `${url}/api/play/${sid}/`);
  assert.ok(path.isAbsolute(script.client) && existsSync(script.client), script.client);
  assert.match(script.token, /^[A-Za-z0-9_-]{43}$/);
  await mcp('act', { session_id: sid, action: 'ACTION4', reasoning: 'tool move' });

  let attach;
  let act;
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'step' && e.data.step.source === 'script'), {
    onEvent: async (ev) => {
      if (ev.event !== 'sessions') return;
      attach = await play(script.base_url, 'attach', { note: 'sweep right to find the goal' }, { token: script.token });
      act = await play(script.base_url, 'act', { run: 1, action: 'ACTION4', reasoning: 'sweep step' }, { token: script.token });
    },
  });
  assert.equal(attach.status, 200);
  assert.equal(attach.body.ok, true);
  assert.equal(attach.body.run, 1);
  assert.equal(attach.body.step, 1);
  assert.equal(attach.body.frame.length, 64);
  assert.equal(attach.body.title, undefined, 'no title in script observations');
  assert.equal(act.body.ok, true);
  assert.deepEqual([act.body.step, act.body.run, act.body.status, act.body.state], [2, 1, 'live', 'NOT_FINISHED']);
  assert.deepEqual(act.body.available_actions, ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6']);
  assert.ok(act.body.frame.every((r) => /^[0-9a-f]{64}$/.test(r)));

  const noteEv = events.find((e) => e.event === 'note');
  assert.equal(noteEv.data.session_id, sid);
  assert.deepEqual({ ...noteEv.data.note, ts: undefined }, { run: 1, ts: undefined, text: 'sweep right to find the goal', from_step: 2 });
  const stepEv = events.find((e) => e.event === 'step' && e.data.step.source === 'script');
  assert.equal(stepEv.data.step.run, 1);

  const steps = (await json(`${url}/api/sessions/${sid}/steps`)).body.steps;
  assert.deepEqual(steps.map((s) => [s.action, s.source, s.run]), [['START', 'tool', undefined], ['ACTION4', 'tool', undefined], ['ACTION4', 'script', 1]]);
  assert.equal(steps[2].reasoning, 'sweep step');
  assert.deepEqual(steps[2].frame, act.body.frame);
  const notes = (await json(`${url}/api/sessions/${sid}/notes`)).body.notes;
  assert.deepEqual(notes.map((n) => [n.run, n.text, n.from_step]), [[1, 'sweep right to find the goal', 2]]);
  assert.equal((await json(`${url}/api/sessions/s-000000000000/notes`)).status, 404);

  const obs = await play(script.base_url, 'observe', {}, { token: script.token });
  assert.deepEqual([obs.body.ok, obs.body.step, obs.body.run], [true, 2, undefined]);
  assert.deepEqual(obs.body.frame, act.body.frame);
  const reset = await play(script.base_url, 'reset', { run: 1, reasoning: 'back to start' }, { token: script.token });
  assert.deepEqual([reset.body.step, reset.body.run], [3, 1]);
  assert.equal((await json(`${url}/api/sessions/${sid}/steps?from=3`)).body.steps[0].source, 'script');
});

test('runs: a note is required, a newer attach supersedes, note() opens the next run', async (t) => {
  const { url, mcp, calls } = await startApp(t);
  const { sid, script } = await scripted(mcp);
  const call = (op, body) => play(script.base_url, op, body, { token: script.token });

  for (const body of [{}, { note: '' }, { note: '   \n\t' }, { note: 'x'.repeat(NOTE_MAX_CHARS + 1) }, { note: 'ok', extra: 1 }, { note: 7 }]) {
    const r = await call('attach', body);
    assert.deepEqual([r.status, r.body.code], [200, 'INVALID_ARGUMENT'], JSON.stringify(body));
  }
  assert.deepEqual((await json(`${url}/api/sessions/${sid}/notes`)).body.notes, [], 'nothing recorded');

  const before = await stepCalls(calls);
  assert.equal((await call('act', { run: 1, action: 'ACTION1' })).body.code, 'NOTE_REQUIRED');
  assert.equal((await call('reset', { run: 1 })).body.code, 'NOTE_REQUIRED');
  assert.equal((await call('note', { run: 1, note: 'n' })).body.code, 'NOTE_REQUIRED');
  assert.equal(await stepCalls(calls), before, 'no toolkit call');

  assert.equal((await call('attach', { note: 'first script' })).body.run, 1);
  assert.equal((await call('attach', { note: 'second script takes over' })).body.run, 2);
  assert.equal((await call('act', { run: 1, action: 'ACTION1' })).body.code, 'RUN_SUPERSEDED');
  assert.equal((await call('note', { run: 1, note: 'stale' })).body.code, 'RUN_SUPERSEDED');
  assert.ok((await call('act', { run: 2, action: 'ACTION1' })).body.ok);
  // A tool step in between does not end the run.
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  const n = await call('note', { run: 2, note: 'phase two: go down' });
  assert.deepEqual(n.body, { ok: true, run: 3 });
  assert.equal((await call('act', { run: 2, action: 'ACTION1' })).body.code, 'RUN_SUPERSEDED');
  assert.ok((await call('act', { run: 3, action: 'ACTION2' })).body.ok);
  const steps = (await json(`${url}/api/sessions/${sid}/steps?from=1`)).body.steps;
  assert.deepEqual(steps.map((s) => [s.source, s.run]), [['script', 2], ['tool', undefined], ['script', 3]]);
  const notes = (await json(`${url}/api/sessions/${sid}/notes`)).body.notes;
  assert.deepEqual(notes.map((x) => [x.run, x.from_step]), [[1, 1], [2, 1], [3, 3]]);
});

test('auth and guard: bad tokens are 401 with no toolkit call; browsers, non-JSON and oversized bodies are refused', async (t) => {
  const { url, mcp, calls } = await startApp(t);
  const { sid, script } = await scripted(mcp);
  const other = await scripted(mcp);
  const before = await stepCalls(calls);
  for (const token of [undefined, '', 'wrong-token', other.script.token, `${script.token}x`]) {
    const r = await play(script.base_url, 'attach', { note: 'n' }, { token });
    assert.deepEqual([r.status, r.body.ok, r.body.code], [401, false, 'TOKEN_INVALID'], String(token));
  }
  const notBearer = await play(script.base_url, 'observe', {}, { headers: { authorization: `Basic ${script.token}` } });
  assert.equal(notBearer.status, 401);
  const tooLong = await play(script.base_url, 'observe', {}, { headers: { authorization: `Bearer ${'a'.repeat(300)}` } });
  assert.equal(tooLong.status, 401);
  assert.equal((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, { token: 'nope' })).status, 401);
  assert.equal(await stepCalls(calls), before);

  const ok = { token: script.token };
  for (const headers of [{ origin: url }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }]) {
    const r = await play(script.base_url, 'attach', { note: 'n' }, { ...ok, headers });
    assert.deepEqual([r.status, r.body.code], [403, 'CROSS_SITE'], JSON.stringify(headers));
  }
  const text = await json(`${script.base_url}attach`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${script.token}` }, body: '{}' });
  assert.equal(text.status, 415);
  assert.equal((await play(script.base_url, 'attach', null, { ...ok, raw: '{"note":' })).body.code, 'BAD_JSON');
  assert.equal((await play(script.base_url, 'attach', { note: 'x'.repeat(BODY_MAX_BYTES) }, ok)).status, 413);
  assert.equal((await play(script.base_url, 'observe', { extra: 1 }, ok)).body.code, 'INVALID_ARGUMENT');
  assert.equal((await play(script.base_url, 'act', { run: 1, action: 'ACTION1', frame: 'full' }, ok)).body.code, 'INVALID_ARGUMENT');
  assert.equal((await play(`${url}/api/play/not-a-session/`, 'observe', {}, ok)).status, 404);
  const unknown = await play(`${url}/api/play/s-ffffffffffff/`, 'observe', {}, ok);
  assert.deepEqual([unknown.status, unknown.body.code], [200, 'SESSION_UNKNOWN']);
  assert.equal((await json(`${script.base_url}attach`)).status, 405);
  assert.equal(await stepCalls(calls), before);
  assert.deepEqual((await json(`${url}/api/sessions/${sid}/notes`)).body.notes, []);
});

test('ownership: the token stands in for the owner; tool callers are still owner-checked', async (t) => {
  const { mcp } = await startApp(t);
  const { sid, script } = await scripted(mcp, {}, A);
  await play(script.base_url, 'attach', { note: 'n' }, { token: script.token });
  assert.ok((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, { token: script.token })).body.ok);
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }, B), 'NOT_OWNER');
  refusal(await mcp('script_access', { session_id: sid }, B), 'NOT_OWNER');
});

test('script_access rotates the token and clears the run', async (t) => {
  const { url, mcp } = await startApp(t);
  const { sid, script } = await scripted(mcp);
  await play(script.base_url, 'attach', { note: 'first' }, { token: script.token });
  const r = ok(await mcp('script_access', { session_id: sid }));
  assert.equal(r.session_id, sid);
  assert.equal(r.script.base_url, `${url}/api/play/${sid}/`);
  assert.equal(r.script.client, script.client);
  assert.notEqual(r.script.token, script.token);
  assert.equal((await play(script.base_url, 'observe', {}, { token: script.token })).status, 401, 'old token is dead');
  assert.equal((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, { token: r.script.token })).body.code, 'NOTE_REQUIRED');
  const again = await play(script.base_url, 'attach', { note: 'after compaction' }, { token: r.script.token });
  assert.equal(again.body.run, 2, 'run numbers keep counting');
  refusal(await mcp('script_access', { session_id: 's-ffffffffffff' }), 'SESSION_UNKNOWN');
  await mcp('end_session', { session_id: sid });
  refusal(await mcp('script_access', { session_id: sid }), 'SESSION_ENDED');
});

test('lifetime: an ended session refuses SESSION_ENDED with its end_reason before any token check, also after a restart', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const { sid, script } = await scripted(first.mcp);
  await play(script.base_url, 'attach', { note: 'n' }, { token: script.token });
  await first.mcp('end_session', { session_id: sid });
  for (const token of [script.token, 'wrong-token', undefined]) {
    for (const [op, body] of [['act', { run: 1, action: 'ACTION1' }], ['observe', {}], ['attach', { note: 'n' }], ['note', { run: 1, note: 'n' }]]) {
      const r = await play(script.base_url, op, body, { token });
      assert.deepEqual([r.status, r.body.code, r.body.end_reason], [200, 'SESSION_ENDED', 'ended_by_agent'], `${op} ${token}`);
    }
  }
  const live = await scripted(first.mcp);
  await first.close();

  // After a restart the session is ended as backend_restart; its old token is
  // unknown, which the ended gate never reaches.
  const second = await startApp(t, { env });
  const base = `${second.url}/api/play/${live.sid}/`;
  for (const token of [live.script.token, 'wrong-token']) {
    const r = await play(base, 'act', { run: 1, action: 'ACTION1' }, { token });
    assert.deepEqual([r.status, r.body.code, r.body.end_reason], [200, 'SESSION_ENDED', 'backend_restart'], String(token));
  }
});

test('the script route gates session and token before the body schema', async (t) => {
  const { mcp } = await startApp(t);
  const { sid, script } = await scripted(mcp);
  const bad = { run: 'one', action: 'ACTION9', extra: true };
  const unknown = await play(script.base_url.replace(sid, 's-ffffffffffff'), 'act', bad, { token: script.token });
  assert.deepEqual([unknown.status, unknown.body.code], [200, 'SESSION_UNKNOWN']);
  const rotated = ok(await mcp('script_access', { session_id: sid })).script.token;
  const stale = await play(script.base_url, 'act', bad, { token: script.token });
  assert.deepEqual([stale.status, stale.body.code], [401, 'TOKEN_INVALID']);
  const live = await play(script.base_url, 'act', bad, { token: rotated });
  assert.deepEqual([live.status, live.body.code], [200, 'INVALID_ARGUMENT'], 'the schema still applies once admitted');
  await mcp('end_session', { session_id: sid });
  const ended = await play(script.base_url, 'act', bad, { token: rotated });
  assert.deepEqual([ended.status, ended.body.code, ended.body.end_reason], [200, 'SESSION_ENDED', 'ended_by_agent']);
});

test('script_access needs a known caller equal to a known owner; other tools keep the null-caller policy', async (t) => {
  const { app, url, mcp } = await startApp(t);
  const NULL = { sessionId: null, project: null };
  const { sid, script } = await scripted(mcp, {}, A);
  await play(script.base_url, 'attach', { note: 'owner script' }, { token: script.token });
  // The probe: a raw api/mcp POST with no caller at all.
  const raw = await sendJsonReq(`${url}/api/mcp`, 'POST', { tool: 'script_access', arguments: { session_id: sid } });
  refusal(raw.body, 'NOT_OWNER');
  refusal(await app.mcp.handle({ tool: 'script_access', arguments: { session_id: sid }, caller: { sessionId: 42 } }), 'NOT_OWNER');
  refusal(await mcp('script_access', { session_id: sid }, NULL), 'NOT_OWNER');
  assert.ok((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, { token: script.token })).body.ok, 'the token and run survived');
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }, NULL));
  ok(await mcp('script_access', { session_id: sid }, A));

  const anon = await scripted(mcp, {}, NULL);
  for (const caller of [NULL, A]) {
    const r = refusal(await mcp('script_access', { session_id: anon.sid }, caller), 'NOT_OWNER');
    assert.match(r.error, /unidentified caller/);
  }
  assert.ok((await play(anon.script.base_url, 'attach', { note: 'n' }, { token: anon.script.token })).body.ok, 'its start_session token still works');

  // An empty sessionId identifies no one: neither as the owner at start nor
  // as the caller at rotation.
  const EMPTY = { sessionId: '', project: 'proj' };
  const empty = await scripted(mcp, {}, EMPTY);
  for (const caller of [EMPTY, NULL, A]) {
    const r = refusal(await mcp('script_access', { session_id: empty.sid }, caller), 'NOT_OWNER');
    assert.match(r.error, /unidentified caller/);
  }
  refusal(await mcp('script_access', { session_id: sid }, EMPTY), 'NOT_OWNER');
  assert.ok((await play(empty.script.base_url, 'attach', { note: 'n' }, { token: empty.script.token })).body.ok, 'the empty-owner session keeps its token');
  ok(await mcp('act', { session_id: anon.sid, action: 'ACTION1' }, B));
});

test(`step rate: ${STEP_RATE_MAX} steps per window across scripts and tools, refused without reaching the toolkit`, async (t) => {
  const clock = fakeClock();
  const { mcp, calls } = await startApp(t, { clock, timers: manualTimers });
  const { sid, script } = await scripted(mcp);
  const tok = { token: script.token };
  assert.ok((await play(script.base_url, 'attach', { note: 'burst' }, tok)).body.ok); // 1
  for (let i = 1; i < STEP_RATE_MAX - 1; i++) assert.ok((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, tok)).body.ok, `act ${i}`);
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' })); // 20
  const before = await stepCalls(calls);
  const refused = await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, tok);
  assert.equal(refused.body.code, 'STEP_RATE_LIMITED');
  assert.equal(refused.body.retry_after_ms, STEP_RATE_WINDOW_MS);
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'STEP_RATE_LIMITED');
  refusal(await mcp('reset', { session_id: sid }), 'STEP_RATE_LIMITED');
  assert.equal((await play(script.base_url, 'note', { run: 1, note: 'n' }, tok)).body.code, 'STEP_RATE_LIMITED');
  assert.equal(await stepCalls(calls), before);
  clock.advance(STEP_RATE_WINDOW_MS);
  assert.ok((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, tok)).body.ok);
});

test(`SESSION_STEP_LIMIT at ${SESSION_STEPS_MAX} steps, for scripts and tools`, async (t) => {
  const { app, mcp, calls } = await startApp(t);
  const { sid, script } = await scripted(mcp);
  const tok = { token: script.token };
  await play(script.base_url, 'attach', { note: 'n' }, tok);
  await app.store.update(sid, { step_count: SESSION_STEPS_MAX });
  const before = await stepCalls(calls);
  assert.equal((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, tok)).body.code, 'SESSION_STEP_LIMIT');
  assert.equal((await play(script.base_url, 'reset', { run: 1 }, tok)).body.code, 'SESSION_STEP_LIMIT');
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'SESSION_STEP_LIMIT');
  refusal(await mcp('reset', { session_id: sid }), 'SESSION_STEP_LIMIT');
  assert.equal(await stepCalls(calls), before);
  await app.store.update(sid, { step_count: SESSION_STEPS_MAX - 1 });
  assert.ok((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, tok)).body.ok);
});

test('the online limiter applies to script steps unchanged', async (t) => {
  const clock = fakeClock();
  const { mcp, calls } = await startApp(t, { clock, timers: manualTimers, onlineRpmLimit: 3 });
  const { script } = await scripted(mcp, { online: true }); // costs 2
  const tok = { token: script.token };
  const attach = await play(script.base_url, 'attach', { note: 'online sweep' }, tok);
  assert.equal(attach.body.online.scorecard_url.startsWith('https://arcprize.org/scorecards/'), true);
  assert.ok((await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, tok)).body.ok); // 3
  const before = await stepCalls(calls);
  const r = await play(script.base_url, 'act', { run: 1, action: 'ACTION1' }, tok);
  assert.equal(r.body.code, 'RATE_LIMITED');
  assert.ok(r.body.retry_after_ms > 0);
  assert.equal(await stepCalls(calls), before);
});

test(`TOO_MANY_NOTES past ${NOTES_MAX} notes`, async (t) => {
  const { url, mcp } = await startApp(t, { stepRate: { max: 10000, windowMs: 1000 } });
  const { sid, script } = await scripted(mcp);
  const tok = { token: script.token };
  let run = (await play(script.base_url, 'attach', { note: 'note 1' }, tok)).body.run;
  for (let i = 2; i <= NOTES_MAX; i++) run = (await play(script.base_url, 'note', { run, note: `note ${i}` }, tok)).body.run;
  assert.equal(run, NOTES_MAX);
  assert.equal((await play(script.base_url, 'note', { run, note: 'one more' }, tok)).body.code, 'TOO_MANY_NOTES');
  assert.equal((await play(script.base_url, 'attach', { note: 'one more' }, tok)).body.code, 'TOO_MANY_NOTES');
  assert.ok((await play(script.base_url, 'act', { run, action: 'ACTION1' }, tok)).body.ok, 'the current run still plays');
  assert.equal((await json(`${url}/api/sessions/${sid}/notes`)).body.notes.length, NOTES_MAX);
});

async function filesUnder(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

test('secrecy: the token appears only in start_session and script_access results, in both formats', async (t) => {
  const { url, mcp, mcpText, log, env, close } = await startApp(t);
  const { sid, script } = await scripted(mcp);
  const rotatedReply = await mcp('script_access', { session_id: sid });
  const rotated = ok(rotatedReply).script.token;
  // The text view of the two token-bearing tools carries the token too: text callers script with it.
  const textSession = await mcpText('start_session', { game_id: 'fake-maze' }, A);
  const sid2 = /Session (s-[0-9a-f]{12})/.exec(textSession.text)[1];
  const textToken = /· token (\S+)/.exec(textSession.text)[1];
  const textRotated = await mcpText('script_access', { session_id: sid2 }, A);
  const textRotatedToken = /· token (\S+)/.exec(textRotated.text)[1];
  assert.notEqual(textRotatedToken, textToken);
  const tokens = [script.token, rotated, textToken, textRotatedToken];
  const seen = [];
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'session' && e.data.status === 'ended'), {
    onEvent: async (ev) => {
      if (ev.event !== 'sessions') return;
      const tok = { token: rotated };
      seen.push(await play(script.base_url, 'attach', { note: 'secrecy check' }, tok));
      seen.push(await play(script.base_url, 'act', { run: 1, action: 'ACTION4', reasoning: 'r' }, tok));
      seen.push(await play(script.base_url, 'note', { run: 1, note: 'next' }, tok));
      seen.push(await play(script.base_url, 'reset', { run: 2 }, tok));
      seen.push(await play(script.base_url, 'observe', {}, tok));
      seen.push(await play(script.base_url, 'observe', {}, { token: script.token }));
      for (const call of [mcp, mcpText]) {
        seen.push(await call('list_games'));
        seen.push(await call('act', { session_id: sid, action: 'ACTION1' }));
        seen.push(await call('observe', { session_id: sid }));
        seen.push(await call('observe', { session_id: sid, frame: 'image' }));
        seen.push(await call('list_sessions', { scope: 'all' }));
        seen.push(await call('act', { session_id: sid2, action: 'ACTION1' }, A));
        // A refusal (here: not the owner) never echoes a token either.
        seen.push(await call('script_access', { session_id: sid }, B));
      }
      seen.push(await mcp('reset', { session_id: sid }));
      seen.push(await mcpText('reset', { session_id: sid }));
      seen.push(await mcp('end_session', { session_id: sid }));
      seen.push(await mcpText('end_session', { session_id: sid2 }, A));
    },
  });
  seen.push(events);
  for (const p of ['api/sessions', `api/sessions/${sid}`, `api/sessions/${sid}/steps`, `api/sessions/${sid}/notes`, 'api/status']) {
    seen.push((await json(`${url}/${p}`)).body);
  }
  await close();
  const blob = JSON.stringify(seen);
  assert.match(blob, /secrecy check/, 'the flow ran');
  for (const f of await filesUnder(env.dataDir)) {
    const text = await fs.readFile(f, 'latin1');
    for (const tk of tokens) assert.ok(!text.includes(tk), `token in ${path.relative(env.dataDir, f)}`);
  }
  for (const tk of tokens) {
    assert.ok(!blob.includes(tk), 'token in a response, result or SSE event');
    assert.ok(!log.text().includes(tk), 'token in the log');
  }
});
