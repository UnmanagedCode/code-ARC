// The two typed formats of every MCP tool (docs/protocol.md → MCP tools):
// json answers {structured} (complete data, valid against the manifest's
// outputSchema), text answers {text} (one prose string), and a refusal is
// {error, code, details?} in both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ok, refusal, startApp, startGame } from './_helpers.mjs';
import { DIFF_MAX_ROWS, LIST_SESSIONS_TEXT_PAGE, SESSION_STEPS_MAX } from '../src/limits.js';

const A = { sessionId: 'agent-a', project: 'proj' };
const FAST = { stepRate: { max: 1000, windowMs: 1000 } };
const GRID_LINE = /^(xx|\d\d)\|/;

// A text success reply: exactly {text}, one prose string (not json).
function prose(r) {
  assert.deepEqual(Object.keys(r), ['text'], JSON.stringify(r));
  assert.equal(typeof r.text, 'string');
  assert.throws(() => JSON.parse(r.text), 'text is prose, not json');
  return r.text;
}
// No `ok` key anywhere in a json view: a structured ok:false would read as a refusal.
const noOkKey = (v) => {
  if (Array.isArray(v)) return v.every(noOkKey);
  if (v && typeof v === 'object') return !('ok' in v) && Object.values(v).every(noOkKey);
  return true;
};

// Pins: every tool answers both formats; json validates and carries no `ok`;
// text is prose naming the session and game.
test('golden path in both formats, tool by tool', async (t) => {
  const { mcp, mcpText, app } = await startApp(t, FAST);

  const games = ok(await mcp('list_games'));
  assert.ok(noOkKey(games));
  const gamesText = prose(await mcpText('list_games'));
  for (const g of games.games) assert.ok(gamesText.includes(g.game_id), g.game_id);

  const start = ok(await mcp('start_session', { game_id: 'fake-maze', max_resets: 2 }));
  assert.ok(noOkKey(start));
  const sid = start.session_id;
  const startText = prose(await mcpText('start_session', { game_id: 'fake-maze' }, { sessionId: 'agent-b', project: 'p' }));
  assert.match(startText, /fake-maze/);

  for (const frame of ['diff', 'full', 'none']) {
    const j = ok(await mcp('act', { session_id: sid, action: 'ACTION1', frame }));
    assert.ok(noOkKey(j));
    const text = prose(await mcpText('act', { session_id: sid, action: 'ACTION1', frame }));
    assert.ok(text.includes(sid) && text.includes('fake-maze'), frame);
  }
  const img = ok(await mcp('act', { session_id: sid, action: 'ACTION1', frame: 'image' }));
  assert.ok(existsSync(img.frame.path));
  const imgText = prose(await mcpText('act', { session_id: sid, action: 'ACTION1', frame: 'image' }));
  assert.match(imgText, /Board image: \S+\.png/);

  const reset = ok(await mcp('reset', { session_id: sid }));
  assert.ok(noOkKey(reset));
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  assert.ok(prose(await mcpText('reset', { session_id: sid })).includes(sid));
  const obs = ok(await mcp('observe', { session_id: sid }));
  assert.ok(noOkKey(obs));
  assert.ok(prose(await mcpText('observe', { session_id: sid })).includes(sid));

  const list = ok(await mcp('list_sessions', { scope: 'all' }));
  assert.ok(noOkKey(list));
  assert.ok(prose(await mcpText('list_sessions', { scope: 'all' })).includes(sid));

  const note = ok(await mcp('note', { session_id: sid, note: 'a plan' }));
  assert.ok(noOkKey(note));
  assert.equal(note.run, 1);
  assert.ok(prose(await mcpText('note', { session_id: sid, note: 'a plan' })).includes(sid));

  const end = ok(await mcp('end_session', { session_id: sid }));
  assert.ok(noOkKey(end));
  const sid2 = ok(await mcp('start_session', { game_id: 'fake-maze' })).session_id;
  const endText = prose(await mcpText('end_session', { session_id: sid2 }));
  assert.ok(endText.includes(sid2) && endText.includes('fake-maze'));
  assert.equal(app.store.get(sid2).status, 'ended');
});

// Pins: the frame data of each mode is the stored frame / the exact differing rows.
test('json frame content: full equals the stored frame, diff lists exactly the changed rows, image is a file', async (t) => {
  const { mcp, mcpText, app } = await startApp(t, FAST);
  const sid = await startGame(mcp);
  const before = app.store.lastFrame(sid);
  const diff = ok(await mcp('act', { session_id: sid, action: 'ACTION4' })).frame;
  const after = app.store.lastFrame(sid);
  assert.equal(diff.mode, 'diff');
  const differing = after.map((row, y) => ({ y, row })).filter(({ y, row }) => row !== before[y]);
  assert.deepEqual(diff.changed_rows, differing);

  const full = ok(await mcp('observe', { session_id: sid }));
  assert.deepEqual(full.frame, { mode: 'full', rows: app.store.lastFrame(sid) });
  assert.deepEqual(ok(await mcp('observe', { session_id: sid, frame: 'none' })).frame, { mode: 'none' });

  // The text full view is the labelled grid: two header lines and 64 rows.
  const text = prose(await mcpText('observe', { session_id: sid }));
  assert.equal(text.split('\n').filter((l) => GRID_LINE.test(l)).length, 66);
  assert.match(text, /Frame full\./);
  // And the text diff names the changed cells.
  const dtext = prose(await mcpText('act', { session_id: sid, action: 'ACTION4', frame: 'diff' }));
  assert.match(dtext, /Frame diff: \d+ changed_cells, bbox x \d+–\d+, y \d+–\d+\./);
  assert.match(dtext, /state \S+ · levels_completed \d+\/\d+ · step \d+/);
});

// Pins: a json diff is complete past the text view's DIFF_MAX_ROWS heuristic,
// which text keeps (it falls back to a full frame).
test('a diff past DIFF_MAX_ROWS is complete in json and full in text', async (t) => {
  const { mcp, mcpText, app } = await startApp(t, FAST);
  const sid = await startGame(mcp);
  const base = app.store.lastFrame(sid);
  // The toolkit's next frame differs from the last in more than DIFF_MAX_ROWS rows.
  const wide = base.map((r, y) => (y <= DIFF_MAX_ROWS + 3 ? r.slice(0, 40) + (r[40] === 'e' ? 'd' : 'e') + r.slice(41) : r));
  const call = app.sidecar.call;
  let steps = 0;
  // Alternates between the wide frame and the base, so each step differs widely from the last.
  app.sidecar.call = async (...a) => {
    const r = await call.apply(app.sidecar, a);
    if (a[0] === 'step' && r.ok) r.result.obs.frame = ++steps % 2 ? wide : base;
    return r;
  };
  const j = ok(await mcp('act', { session_id: sid, action: 'ACTION4' })).frame;
  assert.equal(j.mode, 'diff');
  assert.equal(j.changed_rows.length, DIFF_MAX_ROWS + 4);
  const text = prose(await mcpText('act', { session_id: sid, action: 'ACTION4' }));
  assert.match(text, /Frame full \(auto_full/);
});

// Pins: the json view of list_sessions has no cap; the text view pages with offset.
test('list_sessions: json returns every session, text pages with offset', async (t) => {
  const { mcp, mcpText, app } = await startApp(t);
  const n = LIST_SESSIONS_TEXT_PAGE + 3;
  for (let i = 0; i < n; i++) {
    const id = `s-${String(i).padStart(12, '0')}`;
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    await app.store.create({
      id, game_id: 'fake-maze', title: 'Fake Maze', mode: 'local', max_resets: 0, resets_used: 0, at_level_start: false, owner: { sessionId: 'agent-a', project: 'proj' }, scorecard_id: 'c', scorecard_url: null,
      status: 'ended', end_reason: 'ended_by_agent', stalled: false, created_at: at, updated_at: at, last_activity_at: at, step_count: 0,
      last: { state: 'NOT_FINISHED', levels_completed: 0, win_levels: 3, available_actions: [1], frame_count: 1, full_reset: false },
    });
  }
  const all = ok(await mcp('list_sessions', {}, A));
  assert.equal(all.total, n);
  assert.equal(all.sessions.length, n);
  assert.equal(all.sessions[0].session_id, `s-${String(n - 1).padStart(12, '0')}`, 'newest first');
  const tail = ok(await mcp('list_sessions', { offset: LIST_SESSIONS_TEXT_PAGE }, A));
  assert.equal(tail.sessions.length, 3);
  assert.equal(tail.total, n);

  const page1 = prose(await mcpText('list_sessions', {}, A));
  assert.equal(page1.split('\n').filter((l) => l.startsWith('- ')).length, LIST_SESSIONS_TEXT_PAGE);
  assert.match(page1, new RegExp(`1–${LIST_SESSIONS_TEXT_PAGE} of ${n}`));
  assert.match(page1, new RegExp(`3 more not shown: call list_sessions with offset: ${LIST_SESSIONS_TEXT_PAGE}`));
  const page2 = prose(await mcpText('list_sessions', { offset: LIST_SESSIONS_TEXT_PAGE }, A));
  assert.equal(page2.split('\n').filter((l) => l.startsWith('- ')).length, 3);
  assert.doesNotMatch(page2, /more not shown/);
  assert.match(prose(await mcpText('list_sessions', { offset: n + 10 }, A)), new RegExp(`No sessions at offset ${n + 10} \\(${n} in scope mine\\)`));
  assert.match(prose(await mcpText('list_sessions', {}, { sessionId: 'nobody', project: 'x' })), /No sessions \(scope mine\)/);
});

// Pins: a refusal is the same {error, code, details?} object in both formats,
// with the service's extras under details (and no details when there are none).
test('refusals are identical in both formats and carry their extras under details', async (t) => {
  const clock = { now: () => Date.parse('2026-01-01T00:00:00Z') };
  const { mcp, mcpText, app } = await startApp(t, { stepRate: { max: 1, windowMs: 60000 }, clock });
  const sid = await startGame(mcp, 'fake-maze');
  const both = async (tool, args, code, caller) => {
    const j = refusal(await mcp(tool, args, caller), code);
    const x = refusal(await mcpText(tool, args, caller), code);
    assert.deepEqual(x, j, `${tool} ${code}`);
    return j;
  };

  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  const limited = await both('act', { session_id: sid, action: 'ACTION1' }, 'STEP_RATE_LIMITED');
  assert.ok(Number.isInteger(limited.details.retry_after_ms) && limited.details.retry_after_ms > 0);

  const sid2 = await startGame(mcp, 'fake-maze');
  ok(await mcp('act', { session_id: sid2, action: 'ACTION1' }));
  assert.deepEqual((await both('reset', { session_id: sid2 }, 'RESET_LIMIT')).details, { max_resets: 0, resets_used: 0 });
  const unavailable = await both('act', { session_id: sid2, action: 'ACTION5' }, 'ACTION_UNAVAILABLE');
  assert.ok(Array.isArray(unavailable.details.available_actions));
  assert.equal((await both('act', { session_id: 's-ffffffffffff', action: 'ACTION1' }, 'SESSION_UNKNOWN')).details, undefined);
  assert.equal((await both('act', { session_id: sid2, action: 'ACTION1' }, 'NOT_OWNER', { sessionId: 'agent-b', project: 'p' })).details, undefined);
  await both('act', { session_id: 'nope', action: 'ACTION1' }, 'INVALID_ARGUMENT');
  const misplaced = await both('act', { session_id: sid2, action: 'ACTION1', image_scale: 8 }, 'INVALID_ARGUMENT');
  assert.match(misplaced.error, /frame:'image'/);

  await both('observe', { session_id: sid2, image_scale: 8 }, 'INVALID_ARGUMENT');
  const sid3 = await startGame(mcp, 'fake-maze', { max_resets: 1 });
  ok(await mcp('act', { session_id: sid3, action: 'ACTION1' }));
  await app.store.update(sid3, { step_count: SESSION_STEPS_MAX });
  await both('reset', { session_id: sid3 }, 'SESSION_STEP_LIMIT');

  ok(await mcp('end_session', { session_id: sid2 }));
  const ended = await both('observe', { session_id: sid2, frame: 'image' }, 'SESSION_ENDED');
  assert.equal(ended.details.end_reason, 'ended_by_agent');
});

// Pins: how `format` is read, and that nothing is lost when a handler throws.
test('format dispatch: missing is text, invalid is refused before any work, a crash is INTERNAL', async (t) => {
  const { app, calls, mcp } = await startApp(t);
  const sid = await startGame(mcp);
  const noFormat = await app.mcp.handle({ tool: 'observe', arguments: { session_id: sid }, caller: A });
  assert.equal(typeof prose(noFormat), 'string');

  const before = (await calls()).length;
  for (const format of ['xml', null, 1]) {
    refusal(await app.mcp.handle({ tool: 'list_games', arguments: {}, caller: A, format }), 'INVALID_ARGUMENT');
  }
  assert.equal((await calls()).length, before, 'no toolkit call');

  app.sessions.listGames = async () => { throw new Error('boom'); };
  for (const format of ['json', 'text']) {
    const r = refusal(await app.mcp.handle({ tool: 'list_games', arguments: {}, caller: A, format }), 'INTERNAL');
    assert.equal(r.error, 'internal error in list_games');
    assert.doesNotMatch(JSON.stringify(r), /boom/);
  }
});

// Pins: a failed scorecard close is a warning in both views, not a failure of the end.
test('end_session warnings are returned in json and named in text', async (t) => {
  const { mcp, mcpText, app } = await startApp(t);
  const a = await startGame(mcp);
  const b = await startGame(mcp);
  // Closing the scorecard under the backend's feet makes its own close fail.
  for (const id of [a, b]) assert.equal((await app.sidecar.call('close', { session_id: id }, { timeoutMs: 5000 })).ok, true);
  const j = ok(await mcp('end_session', { session_id: a }));
  assert.equal(j.warnings.length, 1);
  assert.match(j.warnings[0].code, /^[A-Z_]+$/);
  assert.equal(j.final.scorecard, null);
  const text = prose(await mcpText('end_session', { session_id: b }));
  assert.match(text, /scorecard: none returned/);
  assert.match(text, new RegExp(`warning ${j.warnings[0].code}: `));
});

test('text always states the reset budget in observations; list_sessions text marks only sessions with resets', async (t) => {
  const { mcp, mcpText } = await startApp(t, FAST);
  const off = await startGame(mcp, 'fake-maze');
  const on = await startGame(mcp, 'fake-maze', { max_resets: 2 });
  assert.match(prose(await mcpText('observe', { session_id: off })), /max_resets 0 \(one run; reset is refused\)/);
  assert.match(prose(await mcpText('observe', { session_id: on })), /max_resets 2 · resets_used 0 · resets_remaining 2/);
  const lines = prose(await mcpText('list_sessions')).split('\n');
  assert.match(lines.find((l) => l.includes(on)), /resets 0\/2/);
  assert.doesNotMatch(lines.find((l) => l.includes(off)), /resets/);
});
