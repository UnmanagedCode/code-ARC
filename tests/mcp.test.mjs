import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { captureLog, ok, refusal, startApp, startGame } from './_helpers.mjs';
import { decodePng, rgbOf } from './_png.mjs';
import { IMAGE_SPEC, renderBoard } from '../src/boardImage.js';
import { MAX_LIVE_SESSIONS, REASONING_MAX_CHARS } from '../src/limits.js';

const A = { sessionId: 'agent-a', project: 'proj' };
const B = { sessionId: 'agent-b', project: 'other' };
const NULL_CALLER = { sessionId: null, project: null };

test('golden path: list, start, move, ACTION6, observe, reset, end', async (t) => {
  const { mcp, calls, app } = await startApp(t);
  const full = (f) => f.rows;

  const games = ok(await mcp('list_games'));
  assert.ok(games.games.some((g) => g.game_id === 'fake-maze'));

  const start = ok(await mcp('start_session', { game_id: 'fake-maze', allow_reset: true }));
  const sid = start.session_id;
  assert.match(sid, /^s-[0-9a-f]{12}$/);
  assert.equal(start.mode, 'local');
  assert.equal(start.step, 0);
  assert.equal(start.frame.mode, 'full');
  assert.deepEqual(start.available_actions, ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6']);
  assert.equal(full(start.frame).length, 64);
  assert.equal(start.online, undefined);

  const move = ok(await mcp('act', { session_id: sid, action: 'ACTION4', reasoning: 'try moving right' }));
  assert.equal(move.step, 1);
  assert.equal(move.frame.mode, 'diff');
  assert.equal(move.frame.changed_cells, 2);
  assert.equal(move.frame_count, 2);
  assert.ok(move.frame.changed_rows.some((r) => r.y === 2));

  const paint = ok(await mcp('act', { session_id: sid, action: 'ACTION6', x: 10, y: 20, frame: 'full' }));
  assert.equal(paint.frame.mode, 'full');
  assert.equal(paint.frame.rows[20][10], '8');

  const toolkitSteps = (await calls()).filter((c) => c.op === 'step');
  assert.deepEqual(toolkitSteps[0].reasoning, { text: 'try moving right' });
  assert.equal(toolkitSteps[0].data, null);
  assert.deepEqual(toolkitSteps[1].data, { x: 10, y: 20 });
  assert.equal(toolkitSteps[1].reasoning, null);

  const obs = ok(await mcp('observe', { session_id: sid }));
  assert.equal(obs.step, 2);
  assert.deepEqual(obs.frame.rows, paint.frame.rows);
  const none = ok(await mcp('observe', { session_id: sid, frame: 'none' }));
  assert.deepEqual(none.frame, { mode: 'none' });

  const reset = ok(await mcp('reset', { session_id: sid, reasoning: 'start over' }));
  assert.equal(reset.step, 3);
  assert.equal(reset.frame.mode, 'full');
  assert.equal((await calls()).at(-1).op, 'reset');

  const end = ok(await mcp('end_session', { session_id: sid }));
  assert.equal(end.final.scorecard.total_actions, 2);
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
    refusal(r, 'NOT_OWNER');
  }
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }, NULL_CALLER));
  ok(await mcp('observe', { session_id: sid }, B));
  const unowned = await startGame(mcp, 'fake-maze', {}, NULL_CALLER);
  ok(await mcp('act', { session_id: unowned, action: 'ACTION1' }, B));
});

test('gating refusals', async (t) => {
  const { mcp, calls } = await startApp(t);
  const sid = await startGame(mcp);
  const code = async (tool, args, caller) => (await mcp(tool, args, caller)).code;

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

  const unavailable = refusal(await mcp('act', { session_id: sid, action: 'ACTION5' }), 'ACTION_UNAVAILABLE');
  assert.deepEqual(unavailable.details.available_actions, ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION6']);

  // Two acts at once: the second finds the first in flight.
  const [first, second] = await Promise.all([
    mcp('act', { session_id: sid, action: 'ACTION1' }),
    mcp('act', { session_id: sid, action: 'ACTION1' }),
  ]);
  ok(first);
  refusal(second, 'SESSION_BUSY');

  const stepsBefore = (await calls()).filter((c) => c.op === 'step').length;
  await mcp('end_session', { session_id: sid });
  const ended = refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'SESSION_ENDED');
  assert.equal(ended.details.end_reason, 'ended_by_agent');
  assert.equal((await calls()).filter((c) => c.op === 'step').length, stepsBefore, 'refusals never reach the toolkit');
});

test('GAME_FINISHED after a win; reset still works with allow_reset:true', async (t) => {
  const { mcp, calls } = await startApp(t);
  const sid = await startGame(mcp, 'fake-maze', { allow_reset: true });
  for (const a of ['ACTION4', 'ACTION4', 'ACTION4']) await mcp('act', { session_id: sid, action: a });
  let last;
  for (const a of ['ACTION2', 'ACTION2', 'ACTION2']) last = await mcp('act', { session_id: sid, action: a });
  assert.equal(ok(last).state, 'WIN');
  assert.equal(ok(last).levels_completed, 2);
  const steps = (await calls()).filter((c) => c.op === 'step').length;
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1' }), 'GAME_FINISHED');
  assert.equal((await calls()).filter((c) => c.op === 'step').length, steps);
  const reset = await mcp('reset', { session_id: sid });
  assert.equal(ok(reset).state, 'NOT_FINISHED');
  assert.equal(ok(reset).full_reset, true);
});

test(`TOO_MANY_SESSIONS past ${MAX_LIVE_SESSIONS} live sessions`, async (t) => {
  const { mcp } = await startApp(t);
  const ids = [];
  for (let i = 0; i < MAX_LIVE_SESSIONS; i++) ids.push(await startGame(mcp));
  refusal(await mcp('start_session', { game_id: 'fake-maze' }), 'TOO_MANY_SESSIONS');
  await mcp('end_session', { session_id: ids[0] });
  ok(await mcp('start_session', { game_id: 'fake-maze' }));
});

test('a 4000-emoji reasoning is refused before it reaches the toolkit', async (t) => {
  const { mcp, calls } = await startApp(t);
  const sid = await startGame(mcp);
  const emoji = '\u{1F600}'.repeat(REASONING_MAX_CHARS / 2); // 4000 UTF-16 units: the most the schema admits
  const r = refusal(await mcp('act', { session_id: sid, action: 'ACTION1', reasoning: emoji }), 'INVALID_ARGUMENT');
  assert.match(r.details.detail, /bytes/);
  assert.equal((await calls()).filter((c) => c.op === 'step').length, 0);
  // 4000 emoji code points: refused by the length re-check even if a caller
  // counted code points rather than UTF-16 units.
  refusal(await mcp('act', { session_id: sid, action: 'ACTION1', reasoning: '\u{1F600}'.repeat(4000) }), 'INVALID_ARGUMENT');
  assert.equal((await calls()).filter((c) => c.op === 'step').length, 0);
  // The session is still usable.
  ok(await mcp('act', { session_id: sid, action: 'ACTION1', reasoning: 'a'.repeat(REASONING_MAX_CHARS) }));
});

test('list_sessions: mine vs all', async (t) => {
  const { mcp } = await startApp(t);
  const mine = await startGame(mcp, 'fake-maze', {}, A);
  const theirs = await startGame(mcp, 'fake-maze', {}, B);
  const m = ok(await mcp('list_sessions', {}, A));
  assert.deepEqual(m.sessions.map((s) => s.session_id), [mine]);
  const all = ok(await mcp('list_sessions', { scope: 'all' }, A));
  assert.deepEqual(new Set(all.sessions.map((s) => s.session_id)), new Set([mine, theirs]));
});

test('malformed envelopes and unknown tools are {error, code}', async (t) => {
  const { app } = await startApp(t);
  refusal(await app.mcp.handle({ tool: 'frobnicate', arguments: {}, format: 'json' }), 'TOOL_UNKNOWN');
  refusal(await app.mcp.handle(null), 'INVALID_ARGUMENT');
  refusal(await app.mcp.handle({ tool: 'toString', arguments: {}, format: 'text' }), 'TOOL_UNKNOWN');
});

test(`a burst of concurrent starts admits exactly ${MAX_LIVE_SESSIONS}`, async (t) => {
  const { mcp, app } = await startApp(t);
  const n = MAX_LIVE_SESSIONS + 6;
  const results = await Promise.all(Array.from({ length: n }, () => mcp('start_session', { game_id: 'fake-maze' })));
  const started = results.filter((r) => r.structured);
  const refused = results.filter((r) => r.code === 'TOO_MANY_SESSIONS');
  assert.equal(started.length, MAX_LIVE_SESSIONS);
  assert.equal(refused.length, n - MAX_LIVE_SESSIONS);
  assert.equal(app.store.list().filter((m) => m.status === 'live').length, MAX_LIVE_SESSIONS);
});

// frame:'image' (docs/protocol.md → Board image).
const PNG_SIGNATURE = '\x89PNG';

test('image results carry a path, never pixels; the file is the stored frame at the defaults', async (t) => {
  const { mcp, app, env } = await startApp(t, { stepRate: { max: 1000, windowMs: 1000 } });
  const sid = await startGame(mcp, 'fake-maze', { allow_reset: true });
  const raw = {
    act: await mcp('act', { session_id: sid, action: 'ACTION4', frame: 'image' }),
    reset: await mcp('reset', { session_id: sid, frame: 'image' }),
    observe: await mcp('observe', { session_id: sid, frame: 'image' }),
  };
  const results = Object.fromEntries(Object.entries(raw).map(([k, r]) => [k, ok(r)]));
  const imagesDir = path.join(env.dataDir, 'images', sid);
  for (const [tool, r] of Object.entries(results)) {
    assert.deepEqual(Object.keys(r.frame).sort(), ['mode', 'path'], tool);
    assert.equal(r.frame.mode, 'image', tool);
    assert.ok(path.isAbsolute(r.frame.path), tool);
    assert.equal(path.dirname(r.frame.path), imagesDir, tool);
    const s = JSON.stringify(raw[tool]);
    assert.ok(s.length < 4096, `${tool}: result is ${s.length} bytes`);
    assert.ok(!s.includes(PNG_SIGNATURE) && !s.includes('iVBORw0KGgo'), `${tool}: no PNG bytes`);
    assert.doesNotMatch(s, /[A-Za-z0-9+/]{200,}/, `${tool}: no base64 run`);
  }
  assert.equal(results.observe.step, 2);
  // The latest file decodes to the stored last frame at the spec defaults.
  const img = decodePng(await fs.readFile(results.observe.frame.path));
  const want = renderBoard(app.store.lastFrame(sid), { scale: IMAGE_SPEC.scale.default, grid: IMAGE_SPEC.grid.default });
  assert.deepEqual([img.width, img.height], [want.width, want.height]);
  assert.ok(rgbOf(img).equals(want.rgb));
  assert.deepEqual(await fs.readdir(imagesDir), [path.basename(results.observe.frame.path)], 'latest only');
});

test('image options are honoured, and each image gets its own path', async (t) => {
  const { mcp } = await startApp(t);
  const sid = await startGame(mcp);
  const small = ok(await mcp('observe', { session_id: sid, frame: 'image', image_scale: IMAGE_SPEC.scale.min, image_grid: false }));
  const img = decodePng(await fs.readFile(small.frame.path));
  assert.deepEqual([img.width, img.height], [64 * IMAGE_SPEC.scale.min, 64 * IMAGE_SPEC.scale.min]);
  const again = ok(await mcp('observe', { session_id: sid, frame: 'image' }));
  assert.equal(again.step, small.step);
  assert.notEqual(again.frame.path, small.frame.path, 'same step, distinct path');
});

test('image options without frame:image are refused before the toolkit', async (t) => {
  const { mcp, calls } = await startApp(t);
  const sid = await startGame(mcp);
  const before = (await calls()).length;
  for (const [tool, args] of [
    ['act', { action: 'ACTION4', frame: 'diff', image_scale: 8 }],
    ['act', { action: 'ACTION4', image_grid: true }],
    ['reset', { frame: 'full', image_grid: false }],
    ['observe', { image_scale: 8 }],
  ]) {
    const r = refusal(await mcp(tool, { session_id: sid, ...args }), 'INVALID_ARGUMENT');
    assert.match(r.error, /frame:'image'/);
  }
  assert.equal((await calls()).length, before);
});

test('image option bounds are refused before the toolkit', async (t) => {
  const { mcp, calls } = await startApp(t);
  const sid = await startGame(mcp);
  const before = (await calls()).length;
  for (const extra of [{ image_scale: IMAGE_SPEC.scale.min - 1 }, { image_scale: IMAGE_SPEC.scale.max + 1 }, { image_scale: 8.5 }, { image_grid: 'yes' }]) {
    refusal(await mcp('act', { session_id: sid, action: 'ACTION4', frame: 'image', ...extra }), 'INVALID_ARGUMENT');
  }
  assert.equal((await calls()).length, before);
});

test('ended sessions get no image', async (t) => {
  const { mcp, env } = await startApp(t);
  const sid = await startGame(mcp);
  await mcp('end_session', { session_id: sid });
  const r = refusal(await mcp('observe', { session_id: sid, frame: 'image' }), 'SESSION_ENDED');
  assert.equal(r.details.end_reason, 'ended_by_agent');
  assert.deepEqual(await fs.readdir(path.join(env.dataDir, 'images')), []);
  ok(await mcp('observe', { session_id: sid, frame: 'full' }));
});

// Pins: the text view tells the agent the image could not be written and why.
test('a failed image write never fails the action', async (t) => {
  const log = captureLog();
  const { mcp, mcpText, env } = await startApp(t, { log });
  const sid = await startGame(mcp);
  // A regular file where the session's image dir goes: the write fails.
  await fs.writeFile(path.join(env.dataDir, 'images', sid), 'not a dir');
  const r = ok(await mcp('act', { session_id: sid, action: 'ACTION4', frame: 'image' }));
  assert.equal(r.step, 1, 'the action is recorded');
  assert.equal(r.frame.mode, 'image');
  assert.equal(r.frame.path, undefined);
  assert.match(r.frame.error, /not a real directory/);
  assert.match(log.text(), /board image for s-/);
  const text = (await mcpText('observe', { session_id: sid, frame: 'image' })).text;
  assert.match(text, /No image: it could not be written \(error: .*not a real directory.*\)\. The action still happened\./);
});

// Pins: the text view says there is no image because no frame is stored.
test('frame:image with no stored frame reports unavailable no_frame and writes nothing', async (t) => {
  const { mcp, mcpText, app, env } = await startApp(t);
  const sid = await startGame(mcp);
  // The toolkit answers this step without a frame.
  const call = app.sidecar.call;
  app.sidecar.call = async (...a) => {
    const r = await call.apply(app.sidecar, a);
    if (a[0] === 'step' && r.ok) r.result.obs.frame = null;
    return r;
  };
  const r = ok(await mcp('act', { session_id: sid, action: 'ACTION4', frame: 'image' }));
  assert.equal(r.step, 1);
  assert.deepEqual(r.frame, { mode: 'image', unavailable: 'no_frame' });
  assert.match((await mcpText('act', { session_id: sid, action: 'ACTION4', frame: 'image' })).text, /No image: no frame stored\./);
  assert.deepEqual(await fs.readdir(path.join(env.dataDir, 'images')), []);
});

// Pins: the text view says the session ended during the call (no image written).
test('a session that ends during an image call reports unavailable session_ended', async (t) => {
  const { mcp, mcpText, app, env } = await startApp(t);
  const sid = await startGame(mcp);
  // The session ends after the act is recorded, before its image is written.
  const act = app.sessions.act;
  app.sessions.act = async (...a) => {
    const r = await act(...a);
    await app.sessions.onSidecarExit();
    return r;
  };
  const r = ok(await mcp('act', { session_id: sid, action: 'ACTION4', frame: 'image' }));
  assert.equal(r.step, 1, 'the action is recorded');
  assert.deepEqual(r.frame, { mode: 'image', unavailable: 'session_ended' });
  const sid2 = await startGame(mcp);
  assert.match((await mcpText('act', { session_id: sid2, action: 'ACTION4', frame: 'image' })).text, /No image: the session ended during the call\./);
  assert.equal(app.store.get(sid).status, 'ended');
  assert.deepEqual(await fs.readdir(path.join(env.dataDir, 'images')), []);
});
