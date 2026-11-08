import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, refusal, startApp, startGame, sseCollect } from './_helpers.mjs';
import { createRateLimiter, ONLINE_IDLE_CLOSE_MS, scorecardUrl } from '../src/online.js';

const fakeClock = (start = Date.parse('2026-01-01T00:00:00Z')) => {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
};
// Timers whose intervals never fire on their own; the test calls sweep().
const manualTimers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };

test('rate limiter: sliding 60 s window with retry_after', () => {
  const clock = fakeClock();
  const rl = createRateLimiter({ clock, limit: 3 });
  assert.deepEqual(rl.take(2), { ok: true });
  clock.advance(10000);
  assert.deepEqual(rl.take(1), { ok: true });
  const refused = rl.take(1);
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterMs, 50000);
  clock.advance(50000);
  assert.deepEqual(rl.take(2), { ok: true });
});

test('online calls past the limit are refused without reaching the toolkit', async (t) => {
  const clock = fakeClock();
  const { mcp, calls } = await startApp(t, { clock, timers: manualTimers, onlineRpmLimit: 3 });
  const sid = await startGame(mcp, 'fake-maze', { online: true }); // costs 2
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' })); // 3
  const before = (await calls()).length;
  const r = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'RATE_LIMITED');
  assert.ok(Number.isInteger(r.details.retry_after_ms) && r.details.retry_after_ms > 0);
  assert.equal((await calls()).length, before);
  clock.advance(60000);
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  // Local sessions are not limited.
  const local = await startGame(mcp, 'fake-maze');
  for (let i = 0; i < 4; i++) ok(await mcp('act', { session_id: local, action: 'ACTION1' }));
});

test('online results carry the scorecard url and idle close time; local ones do not', async (t) => {
  const clock = fakeClock();
  const { mcp, app } = await startApp(t, { clock, timers: manualTimers });
  const start = ok(await mcp('start_session', { game_id: 'fake-maze', online: true }));
  const card = app.store.get(start.session_id).scorecard_id;
  assert.equal(start.mode, 'online');
  assert.equal(start.online.scorecard_url, `https://arcprize.org/scorecards/${card}`);
  assert.equal(start.online.idle_close_at, new Date(clock.now() + ONLINE_IDLE_CLOSE_MS).toISOString());
  const local = ok(await mcp('start_session', { game_id: 'fake-maze' }));
  assert.equal(local.online, undefined);
  assert.equal(app.store.get(local.session_id).scorecard_url, null);
  assert.equal(scorecardUrl('../x'), null);
});

test('idle sweep ends idle online sessions as scorecard_auto_closed and publishes it', async (t) => {
  const clock = fakeClock();
  const { mcp, app, url } = await startApp(t, { clock, timers: manualTimers });
  const sid = await startGame(mcp, 'fake-maze', { online: true });
  const local = await startGame(mcp, 'fake-maze');
  clock.advance(ONLINE_IDLE_CLOSE_MS - 1);
  await app.sessions.sweep();
  assert.equal(app.store.get(sid).status, 'live');
  clock.advance(1);
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'session' && e.data.id === sid && e.data.status === 'ended'), {
    onEvent: async (ev) => { if (ev.event === 'sessions') await app.sessions.sweep(); },
  });
  const ended = events.find((e) => e.event === 'session' && e.data.id === sid);
  assert.equal(ended.data.end_reason, 'scorecard_auto_closed');
  assert.equal(app.store.get(local).status, 'live', 'local sessions never auto-close');
  const r = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'SESSION_ENDED');
  assert.equal(r.details.end_reason, 'scorecard_auto_closed');
});

test('toolkit 429 is RATE_LIMITED; a closed scorecard ends the session', async (t) => {
  const { mcp, app } = await startApp(t);
  const s429 = await startGame(mcp, 'fake-429', { online: true });
  refusal(await mcp('act', { session_id: s429, action: 'ACTION1' }), 'RATE_LIMITED');
  assert.equal(app.store.get(s429).status, 'live');
  const closed = await startGame(mcp, 'fake-closed', { online: true });
  refusal(await mcp('act', { session_id: closed, action: 'ACTION1' }), 'SCORECARD_CLOSED');
  assert.equal(app.store.get(closed).status, 'ended');
  assert.equal(app.store.get(closed).end_reason, 'scorecard_auto_closed');
});
