import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, startGame } from './_helpers.mjs';
import { MAX_LIVE_SESSIONS, REASONING_MAX_CHARS } from '../src/limits.js';

const A = { sessionId: 'agent-a', project: 'proj' };
const B = { sessionId: 'agent-b', project: 'other' };
const NULL_CALLER = { sessionId: null, project: null };

test('golden path: list, start, move, ACTION6, observe, reset, end', async (t) => {
  const { mcp, calls, app } = await startApp(t);

  const games = await mcp('list_games');
  assert.equal(games.result.ok, true);
  assert.ok(games.result.games.some((g) => g.game_id === 'fake-maze'));

  const start = await mcp('start_session', { game_id: 'fake-maze' });
  const sid = start.meta.session_id;
  assert.match(sid, /^s-[0-9a-f]{12}$/);
  assert.equal(start.meta.mode, 'local');
  assert.equal(start.meta.step, 0);
  assert.equal(start.meta.frame.mode, 'full');
  assert.deepEqual(start.meta.available_actions, ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6']);
  assert.equal(start.text[0].split('\n').length, 66);
  assert.equal(start.meta.online, undefined);

  const move = await mcp('act', { session_id: sid, action: 'ACTION4', reasoning: 'try moving right' });
  assert.equal(move.meta.step, 1);
  assert.equal(move.meta.frame.mode, 'diff');
  assert.equal(move.meta.frame.changed_cells, 2);
  assert.equal(move.meta.frame_count, 2);
  assert.match(move.text[0], /^02\|/m);

  const paint = await mcp('act', { session_id: sid, action: 'ACTION6', x: 10, y: 20, frame: 'full' });
  assert.equal(paint.meta.frame.mode, 'full');
  assert.equal(paint.text[0].split('\n')[2 + 20][3 + 10], '8');

  const toolkitSteps = (await calls()).filter((c) => c.op === 'step');
  assert.deepEqual(toolkitSteps[0].reasoning, { text: 'try moving right' });
  assert.equal(toolkitSteps[0].data, null);
  assert.deepEqual(toolkitSteps[1].data, { x: 10, y: 20 });
  assert.equal(toolkitSteps[1].reasoning, null);

  const obs = await mcp('observe', { session_id: sid });
  assert.equal(obs.meta.step, 2);
  assert.equal(obs.text[0], paint.text[0]);
  const none = await mcp('observe', { session_id: sid, frame: 'none' });
  assert.equal(none.text[0], '');

  const reset = await mcp('reset', { session_id: sid, reasoning: 'start over' });
  assert.equal(reset.meta.step, 3);
  assert.equal(reset.meta.frame.mode, 'full');
  assert.equal((await calls()).at(-1).op, 'reset');

  const end = await mcp('end_session', { session_id: sid });
  assert.equal(end.result.ok, true);
  assert.equal(end.result.final.scorecard.total_actions, 2);
  const card = (await calls()).find((c) => c.op === 'create_scorecard').card_id;
  assert.ok((await calls()).some((c) => c.op === 'close_scorecard' && c.card_id === card));
  assert.equal(app.store.get(sid).end_reason, 'ended_by_agent');
});

test('caller identity is stored as the owner', async (t) => {
  const { mcp, app } = await startApp(t);
  const sid = await startGame(mcp, 'fake-maze', {}, A);
  assert.deepEqual(app.store.get(sid).owner, { sessionId: 'agent-a', project: 'proj' });
  const anon = await startGame(mcp, 'fake-maze', {}, NULL_CALLER);
  assert.deepEqual(app.store.get(anon).owner, { sessionId: null, project: null });
});

test('NOT_OWNER only when both owner and caller are known and differ', async (t) => {
  const { mcp } = await startApp(t);
  const sid = await startGame(mcp, 'fake-maze', {}, A);
  for (const [tool, args] of [['act', { action: 'ACTION1' }], ['reset', {}], ['end_session', {}]]) {
    const r = await mcp(tool, { session_id: sid, ...args }, B);
    assert.equal(r.result.code, 'NOT_OWNER', tool);
  }
  assert.ok((await mcp('act', { session_id: sid, action: 'ACTION1' }, NULL_CALLER)).meta, 'null caller may act');
  assert.ok((await mcp('observe', { session_id: sid }, B)).meta, 'observe is open to all');
  const unowned = await startGame(mcp, 'fake-maze', {}, NULL_CALLER);
  assert.ok((await mcp('act', { session_id: unowned, action: 'ACTION1' }, B)).meta, 'unowned session is open');
});

test('gating refusals', async (t) => {
  const { mcp, calls } = await startApp(t);
  const sid = await startGame(mcp);
  const code = async (tool, args, caller) => (await mcp(tool, args, caller)).result?.code;

  assert.equal(await code('act', { session_id: 's-ffffffffffff', action: 'ACTION1' }), 'SESSION_UNKNOWN');
  assert.equal(await code('observe', { session_id: 's-ffffffffffff' }), 'SESSION_UNKNOWN');
  assert.equal(await code('act', { session_id: 'nope', action: 'ACTION1' }), 'INVALID_ARGUMENT');
  assert.equal(await code('act', { session_id: sid, action: 'ACTION6' }), 'INVALID_ARGUMENT');
  assert.equal(await code('act', { session_id: sid, action: 'ACTION6', x: 64, y: 0 }), 'INVALID_ARGUMENT');
  assert.equal(await code('act', { session_id: sid, action: 'ACTION1', x: 1, y: 1 }), 'INVALID_ARGUMENT');
  assert.equal(await code('act', { session_id: sid, action: 'ACTION1', extra: 1 }), 'INVALID_ARGUMENT');
  assert.equal(await code('act', { session_id: sid, action: 'ACTION1', reasoning: 'x'.repeat(REASONING_MAX_CHARS + 1) }), 'INVALID_ARGUMENT');
  assert.equal(await code('start_session', { game_id: 'no-such-game' }), 'GAME_UNKNOWN');
  assert.equal(await code('start_session', { game_id: '../etc' }), 'INVALID_ARGUMENT');

  const unavailable = (await mcp('act', { session_id: sid, action: 'ACTION5' })).result;
  assert.equal(unavailable.code, 'ACTION_UNAVAILABLE');
  assert.deepEqual(unavailable.available_actions, ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6']);

  // Two acts at once: the second finds the first in flight.
  const [first, second] = await Promise.all([
    mcp('act', { session_id: sid, action: 'ACTION1' }),
    mcp('act', { session_id: sid, action: 'ACTION1' }),
  ]);
  assert.ok(first.meta);
  assert.equal(second.result.code, 'SESSION_BUSY');

  const stepsBefore = (await calls()).filter((c) => c.op === 'step').length;
  await mcp('end_session', { session_id: sid });
  const ended = (await mcp('act', { session_id: sid, action: 'ACTION1' })).result;
  assert.equal(ended.code, 'SESSION_ENDED');
  assert.equal(ended.end_reason, 'ended_by_agent');
  assert.equal((await calls()).filter((c) => c.op === 'step').length, stepsBefore, 'refusals never reach the toolkit');
});

test('GAME_FINISHED after a win; reset still works', async (t) => {
  const { mcp, calls } = await startApp(t);
  const sid = await startGame(mcp);
  for (const a of ['ACTION4', 'ACTION4', 'ACTION4']) await mcp('act', { session_id: sid, action: a });
  let last;
  for (const a of ['ACTION2', 'ACTION2', 'ACTION2']) last = await mcp('act', { session_id: sid, action: a });
  assert.equal(last.meta.state, 'WIN');
  assert.equal(last.meta.levels_completed, 2);
  const steps = (await calls()).filter((c) => c.op === 'step').length;
  const r = (await mcp('act', { session_id: sid, action: 'ACTION1' })).result;
  assert.equal(r.code, 'GAME_FINISHED');
  assert.equal((await calls()).filter((c) => c.op === 'step').length, steps);
  const reset = await mcp('reset', { session_id: sid });
  assert.equal(reset.meta.state, 'NOT_FINISHED');
  assert.equal(reset.meta.full_reset, true);
});

test(`TOO_MANY_SESSIONS past ${MAX_LIVE_SESSIONS} live sessions`, async (t) => {
  const { mcp } = await startApp(t);
  const ids = [];
  for (let i = 0; i < MAX_LIVE_SESSIONS; i++) ids.push(await startGame(mcp));
  assert.equal((await mcp('start_session', { game_id: 'fake-maze' })).result.code, 'TOO_MANY_SESSIONS');
  await mcp('end_session', { session_id: ids[0] });
  assert.ok((await mcp('start_session', { game_id: 'fake-maze' })).meta);
});

test('a 4000-emoji reasoning is refused before it reaches the toolkit', async (t) => {
  const { mcp, calls } = await startApp(t);
  const sid = await startGame(mcp);
  const emoji = '\u{1F600}'.repeat(REASONING_MAX_CHARS / 2); // 4000 UTF-16 units: the most the schema admits
  const r = (await mcp('act', { session_id: sid, action: 'ACTION1', reasoning: emoji })).result;
  assert.equal(r.code, 'INVALID_ARGUMENT');
  assert.match(r.detail, /bytes/);
  assert.equal((await calls()).filter((c) => c.op === 'step').length, 0);
  // 4000 emoji code points: refused by the length re-check even if a caller
  // counted code points rather than UTF-16 units.
  const r4000 = (await mcp('act', { session_id: sid, action: 'ACTION1', reasoning: '\u{1F600}'.repeat(4000) })).result;
  assert.equal(r4000.code, 'INVALID_ARGUMENT');
  assert.equal((await calls()).filter((c) => c.op === 'step').length, 0);
  // The session is still usable.
  assert.ok((await mcp('act', { session_id: sid, action: 'ACTION1', reasoning: 'a'.repeat(REASONING_MAX_CHARS) })).meta);
});

test('list_sessions: mine vs all', async (t) => {
  const { mcp } = await startApp(t);
  const mine = await startGame(mcp, 'fake-maze', {}, A);
  const theirs = await startGame(mcp, 'fake-maze', {}, B);
  const m = (await mcp('list_sessions', {}, A)).result;
  assert.deepEqual(m.sessions.map((s) => s.session_id), [mine]);
  const all = (await mcp('list_sessions', { scope: 'all' }, A)).result;
  assert.deepEqual(new Set(all.sessions.map((s) => s.session_id)), new Set([mine, theirs]));
});

test('malformed envelopes and unknown tools are {error}', async (t) => {
  const { app } = await startApp(t);
  assert.ok((await app.mcp.handle({ tool: 'frobnicate', arguments: {} })).error);
  assert.ok((await app.mcp.handle(null)).error);
  assert.ok((await app.mcp.handle({ tool: 'toString', arguments: {} })).error);
});
