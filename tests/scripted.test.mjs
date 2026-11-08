// Scripted play: a json-format call is a program (cc's run_code), so its steps
// are recorded as scripted; the note tool opens the runs they record. Source
// attribution, runs, gating, limits, pruning and the retired script HTTP API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, json, ok, refusal, sendJsonReq, sseCollect, startApp, until } from './_helpers.mjs';
import { ONLINE_IDLE_CLOSE_MS } from '../src/online.js';
import { DEADLINES, NOTE_MAX_CHARS, NOTES_MAX, SESSION_STEPS_MAX, STEP_RATE_MAX, STEP_RATE_WINDOW_MS } from '../src/limits.js';

const A = { sessionId: 'agent-a', project: 'proj' };
const B = { sessionId: 'agent-b', project: 'other' };
const NULL = { sessionId: null, project: null };
const fakeClock = (start = Date.parse('2026-01-01T00:00:00Z')) => {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
};
const manualTimers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };
const stepCalls = async (calls) => (await calls()).filter((c) => c.op === 'step' || c.op === 'reset').length;
const stepsOf = async (url, sid, from = 0) => (await json(`${url}/api/sessions/${sid}/steps?from=${from}`)).body.steps;
const notesOf = async (url, sid) => (await json(`${url}/api/sessions/${sid}/notes`)).body.notes;
const start = async (mcp, extra = {}, caller = A) => ok(await mcp('start_session', { game_id: 'fake-maze', ...extra }, caller)).session_id;
const ended = (app, sid) => app.store.get(sid).status === 'ended';

// Pins: the step's source follows the call's format; a script step records the
// run only once a note opened one; START and direct service calls are tagged too.
test('source attribution: text steps are tool steps, json steps are script steps under the latest note', async (t) => {
  const { app, url, mcp, mcpText } = await startApp(t);
  const sid = await start(mcp);
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  assert.equal((await mcpText('act', { session_id: sid, action: 'ACTION1' })).text.startsWith('Session'), true);
  assert.equal((await mcpText('reset', { session_id: sid })).text.startsWith('Session'), true);
  ok(await mcp('note', { session_id: sid, note: 'sweep' }));
  ok(await mcp('act', { session_id: sid, action: 'ACTION2' }));
  await mcpText('act', { session_id: sid, action: 'ACTION1' });
  ok(await mcp('reset', { session_id: sid }));
  await app.sessions.act({ session_id: sid, action: 'ACTION1' }, A);
  const steps = await stepsOf(url, sid);
  assert.deepEqual(steps.map((s) => [s.action, s.source, s.run]), [
    ['START', 'script', undefined],
    ['ACTION1', 'script', undefined],
    ['ACTION1', 'tool', undefined],
    ['RESET', 'tool', undefined],
    ['ACTION2', 'script', 1],
    ['ACTION1', 'tool', undefined],
    ['RESET', 'script', 1],
    ['ACTION1', 'tool', undefined],
  ]);

  const textStart = await mcpText('start_session', { game_id: 'fake-maze' }, A);
  const textSid = /Session (s-[0-9a-f]{12})/.exec(textStart.text)[1];
  assert.deepEqual((await stepsOf(url, textSid))[0].source, 'tool', 'START follows start_session\'s format');
});

test('the SSE step event carries the same source and run as the stored step', async (t) => {
  const { url, mcp } = await startApp(t);
  const sid = await start(mcp);
  let acted = false;
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'step' && e.data.step.n === 1), {
    onEvent: async (ev) => {
      if (ev.event !== 'sessions' || acted) return;
      acted = true;
      ok(await mcp('note', { session_id: sid, note: 'n' }));
      ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
    },
  });
  const live = events.find((e) => e.event === 'step' && e.data.step.n === 1).data.step;
  assert.deepEqual([live.source, live.run], ['script', 1]);
  assert.deepEqual((await stepsOf(url, sid, 1))[0], live);
});

// Pins: note returns {session_id, run}, stores and announces {run, text, from_step},
// runs count per session, later json steps take the newest, a tool step ends nothing.
test('note: opens runs 1, 2, 3; stored, announced and named in both views', async (t) => {
  const { url, mcp, mcpText } = await startApp(t);
  const sid = await start(mcp);
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  let first;
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'note'), {
    onEvent: async (ev) => {
      if (ev.event === 'sessions') first = await mcp('note', { session_id: sid, note: 'sweep right to find the goal' });
    },
  });
  assert.deepEqual(ok(first), { session_id: sid, run: 1 });
  const noteEv = events.find((e) => e.event === 'note');
  assert.equal(noteEv.data.session_id, sid);
  assert.deepEqual({ ...noteEv.data.note, ts: undefined }, { run: 1, ts: undefined, text: 'sweep right to find the goal', from_step: 2 });

  const text = (await mcpText('note', { session_id: sid, note: 'phase two' })).text;
  assert.match(text, new RegExp(`Run 2 opened on ${sid}`));
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  await mcpText('act', { session_id: sid, action: 'ACTION1' }); // a tool step in between
  assert.deepEqual(ok(await mcp('note', { session_id: sid, note: 'phase three' })), { session_id: sid, run: 3 });
  ok(await mcp('act', { session_id: sid, action: 'ACTION2' }));
  assert.deepEqual((await stepsOf(url, sid, 2)).map((s) => [s.source, s.run]), [['script', 2], ['tool', undefined], ['script', 3]]);
  assert.deepEqual((await notesOf(url, sid)).map((n) => [n.run, n.text, n.from_step]), [[1, 'sweep right to find the goal', 2], [2, 'phase two', 2], [3, 'phase three', 4]]);
  assert.equal((await json(`${url}/api/sessions/s-000000000000/notes`)).status, 404);
});

// Pins: a refused note stores nothing and spends no step-rate slot; the gate
// order is session, ended, owner, argument.
test('note validation and gating', async (t) => {
  const clock = fakeClock();
  const { url, mcp } = await startApp(t, { clock, timers: manualTimers });
  const sid = await start(mcp);
  for (const args of [{}, { note: '' }, { note: '   \n\t' }, { note: 'x'.repeat(NOTE_MAX_CHARS + 1) }, { note: 7 }]) {
    refusal(await mcp('note', { session_id: sid, ...args }), 'INVALID_ARGUMENT');
  }
  assert.deepEqual(await notesOf(url, sid), [], 'nothing recorded');
  // No slot was spent: a full window of steps still fits.
  for (let i = 0; i < STEP_RATE_MAX; i++) ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'STEP_RATE_LIMITED');
  clock.advance(STEP_RATE_WINDOW_MS);

  refusal(await mcp('note', { session_id: 's-ffffffffffff', note: 'n' }), 'SESSION_UNKNOWN');
  refusal(await mcp('note', { session_id: 's-ffffffffffff', note: '  ' }), 'SESSION_UNKNOWN');
  refusal(await mcp('note', { session_id: sid, note: 'n' }, B), 'NOT_OWNER');
  ok(await mcp('note', { session_id: sid, note: 'null caller allowed' }, NULL));
  assert.deepEqual((await notesOf(url, sid)).map((n) => n.text), ['null caller allowed'], 'the null caller\'s note was recorded');
  await mcp('end_session', { session_id: sid });
  const r = refusal(await mcp('note', { session_id: sid, note: 'n' }), 'SESSION_ENDED');
  assert.equal(r.details.end_reason, 'ended_by_agent');
});

// Pins: a rate-refused note leaves the notes list and the run counter as they were.
test('a refused note changes nothing: no stored note, no new run', async (t) => {
  const clock = fakeClock();
  const { url, mcp } = await startApp(t, { clock, timers: manualTimers });
  const sid = await start(mcp);
  ok(await mcp('note', { session_id: sid, note: 'first' }));
  for (let i = 1; i < STEP_RATE_MAX; i++) ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  const before = await notesOf(url, sid);
  refusal(await mcp('note', { session_id: sid, note: 'refused' }), 'STEP_RATE_LIMITED');
  assert.deepEqual(await notesOf(url, sid), before);
  clock.advance(STEP_RATE_WINDOW_MS);
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  assert.equal((await stepsOf(url, sid, STEP_RATE_MAX))[0].run, 1, 'the next step still records the pre-refusal run');
  assert.equal(ok(await mcp('note', { session_id: sid, note: 'second' })).run, 2, 'the next note takes the next run');
});

// Pins: with NOTES_MAX reached and the rate window full, TOO_MANY_NOTES wins over STEP_RATE_LIMITED.
test('note gating: TOO_MANY_NOTES is checked before STEP_RATE_LIMITED', async (t) => {
  const clock = fakeClock();
  const { mcp } = await startApp(t, { clock, timers: manualTimers });
  const sid = await start(mcp);
  for (let i = 0; i < NOTES_MAX; i++) {
    if (i % STEP_RATE_MAX === 0) clock.advance(STEP_RATE_WINDOW_MS);
    ok(await mcp('note', { session_id: sid, note: `n${i}` }));
  }
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'STEP_RATE_LIMITED'); // the window is full
  refusal(await mcp('note', { session_id: sid, note: 'one more' }), 'TOO_MANY_NOTES');
});

test(`TOO_MANY_NOTES past ${NOTES_MAX} notes; json steps still play under the last run`, async (t) => {
  const { url, mcp } = await startApp(t, { stepRate: { max: 10000, windowMs: 1000 } });
  const sid = await start(mcp);
  let run = 0;
  for (let i = 1; i <= NOTES_MAX; i++) run = ok(await mcp('note', { session_id: sid, note: `note ${i}` })).run;
  assert.equal(run, NOTES_MAX);
  refusal(await mcp('note', { session_id: sid, note: 'one more' }), 'TOO_MANY_NOTES');
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  assert.equal((await stepsOf(url, sid, 1))[0].run, NOTES_MAX);
  assert.equal((await notesOf(url, sid)).length, NOTES_MAX);
});

// Pins: one per-session budget covers note and act/reset in both formats; a
// refusal names retry_after_ms and never reaches the toolkit; the window recovers.
test(`step rate: ${STEP_RATE_MAX} per window across notes and json and text steps`, async (t) => {
  const clock = fakeClock();
  const { mcp, mcpText, calls } = await startApp(t, { clock, timers: manualTimers });
  const sid = await start(mcp);
  ok(await mcp('note', { session_id: sid, note: 'burst' })); // 1
  for (let i = 1; i < STEP_RATE_MAX - 1; i++) ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  await mcpText('act', { session_id: sid, action: 'ACTION1' }); // 20
  const before = await stepCalls(calls);
  const r = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'STEP_RATE_LIMITED');
  assert.equal(r.details.retry_after_ms, STEP_RATE_WINDOW_MS);
  refusal(await mcp('reset', { session_id: sid }), 'STEP_RATE_LIMITED');
  refusal(await mcpText('act', { session_id: sid, action: 'ACTION1' }), 'STEP_RATE_LIMITED');
  refusal(await mcp('note', { session_id: sid, note: 'n' }), 'STEP_RATE_LIMITED');
  assert.equal(await stepCalls(calls), before);
  clock.advance(STEP_RATE_WINDOW_MS);
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
});

test(`SESSION_STEP_LIMIT at ${SESSION_STEPS_MAX} steps, in both formats`, async (t) => {
  const { app, mcp, mcpText, calls } = await startApp(t);
  const sid = await start(mcp);
  await app.store.update(sid, { step_count: SESSION_STEPS_MAX });
  const before = await stepCalls(calls);
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'SESSION_STEP_LIMIT');
  refusal(await mcp('reset', { session_id: sid }), 'SESSION_STEP_LIMIT');
  refusal(await mcpText('act', { session_id: sid, action: 'ACTION1' }), 'SESSION_STEP_LIMIT');
  assert.equal(await stepCalls(calls), before);
  await app.store.update(sid, { step_count: SESSION_STEPS_MAX - 1 });
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
});

test('the online limiter applies to json steps unchanged', async (t) => {
  const clock = fakeClock();
  const { mcp, calls } = await startApp(t, { clock, timers: manualTimers, onlineRpmLimit: 3 });
  const sid = await start(mcp, { online: true }); // costs 2
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' })); // 3
  const before = await stepCalls(calls);
  const r = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'RATE_LIMITED');
  assert.ok(r.details.retry_after_ms > 0);
  assert.equal(await stepCalls(calls), before);
});

// Pins: the run counter lives in the runtime entry and goes with it on every end path.
test('per-session entries (runtime state and run counters) are pruned when a session ends, by every path', async (t) => {
  const clock = fakeClock();
  const { app, mcp } = await startApp(t, { clock, timers: manualTimers, deadlines: { ...DEADLINES, step: 150 } });
  const counts = () => app.sessions._entryCounts();
  const zero = { runtime: 0 };

  const a = await start(mcp);
  ok(await mcp('note', { session_id: a, note: 'n' }));
  ok(await mcp('act', { session_id: a, action: 'ACTION1' }));
  assert.deepEqual(counts(), { runtime: 1 });
  await mcp('end_session', { session_id: a });
  assert.deepEqual(counts(), zero);
  refusal(await mcp('note', { session_id: a, note: 'n' }), 'SESSION_ENDED');
  refusal(await mcp('act', { session_id: a, action: 'ACTION1' }), 'SESSION_ENDED');
  assert.deepEqual(counts(), zero, 'a refused call re-creates nothing');

  const closed = await start(mcp, { game_id: 'fake-closed', online: true });
  refusal(await mcp('act', { session_id: closed, action: 'ACTION1' }), 'SCORECARD_CLOSED');
  assert.deepEqual(counts(), zero);

  const idle = await start(mcp, { online: true });
  await mcp('act', { session_id: idle, action: 'ACTION1' });
  clock.advance(ONLINE_IDLE_CLOSE_MS);
  await app.sessions.sweep();
  assert.ok(ended(app, idle));
  assert.deepEqual(counts(), zero);

  let lateSeen = false;
  const call = app.sidecar.call;
  app.sidecar.call = (op, args, o = {}) => call(op, args, o.onLate ? { ...o, onLate: (r) => { o.onLate(r); lateSeen = true; } } : o);
  const slow = await start(mcp, { game_id: 'fake-slow' });
  refusal(await mcp('act', { session_id: slow, action: 'ACTION1' }), 'TOOLKIT_TIMEOUT');
  await mcp('end_session', { session_id: slow });
  await until(() => lateSeen);
  assert.deepEqual(counts(), zero);
  assert.equal(app.store.get(slow).step_count, 0, 'the late step is not recorded on the ended session');

  const other = await start(mcp);
  const crash = await start(mcp, { game_id: 'fake-crash' });
  refusal(await mcp('act', { session_id: crash, action: 'ACTION1' }), 'SIDECAR_EXITED');
  await until(() => ended(app, other) && ended(app, crash));
  assert.deepEqual(counts(), zero);
});

// Pins: the script HTTP API and its token are gone for good.
test('retired surface: no script_access tool, no script block, no api/play routes', async (t) => {
  const { url, app, mcp, mcpText } = await startApp(t);
  const sid = await start(mcp);
  refusal(await mcp('script_access', { session_id: sid }), 'TOOL_UNKNOWN');
  const started = ok(await mcp('start_session', { game_id: 'fake-maze' }, A));
  assert.equal('script' in started, false);
  assert.doesNotMatch((await mcpText('start_session', { game_id: 'fake-maze' }, A)).text, /Script access|token/);

  const r = await sendJsonReq(`${url}/api/play/${sid}/act`, 'POST', { run: 1, action: 'ACTION1' }, { authorization: 'Bearer x' });
  assert.equal(r.status, 404);
  assert.equal(app.store.get(sid).step_count, 0, 'nothing was recorded');
});
