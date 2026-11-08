// The animation argument of act and observe (src/mcp.js, src/animation.js), end to
// end through the real sidecar on the fake toolkit: fake-maze moves are two
// frames, fake-anim ACTION1 is 70 (over the stored cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { freshEnv, ok, refusal, startApp, startGame } from './_helpers.mjs';
import { captureDefaults } from './_golden.mjs';
import { decodePng } from './_png.mjs';
import { ANIMATION_FRAMES_MAX, ANIMATION_PAGE_MAX } from '../src/limits.js';
import { IMAGE_SPEC } from '../src/boardImage.js';

const FAST = { stepRate: { max: 1000, windowMs: 1000 } };
const golden = JSON.parse(await fs.readFile(new URL('./fixtures/act-default.json', import.meta.url), 'utf8'));

test('default output is byte-identical: act and observe without animation, and with animation:"last", match the golden fixture', async (t) => {
  assert.deepEqual(await captureDefaults(t), golden);
  assert.deepEqual(await captureDefaults(t, { animation: 'last' }), golden);
});

test('act animation:"all" in json: index 0 full, index 1 a diff against it, step matches the result', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp);
  const r = ok(await mcp('act', { session_id: sid, action: 'ACTION4', animation: 'all' }));
  assert.equal(r.frame_count, 2);
  const a = r.animation;
  assert.equal(a.step, r.step);
  assert.deepEqual([a.stored, a.omitted, a.truncated, a.next_from, a.from], [2, 0, false, null, 0]);
  assert.deepEqual(a.frames.map((f) => [f.index, f.mode]), [[0, 'full'], [1, 'diff']]);
  assert.equal(a.frames[0].rows.length, 64);
  // The player moved right: the diff against frame 0 touches the player's row only.
  assert.ok(a.frames[1].changed_cells > 0);
  assert.equal(r.frame.mode, 'diff', 'frame still describes the last frame');
});

test('act animation:"all" in text: frame sections after the usual frame text', async (t) => {
  const { mcpText } = await startApp(t, FAST);
  const start = await mcpText('start_session', { game_id: 'fake-maze' });
  const sid = /s-[0-9a-f]{12}/.exec(start.text)[0];
  const { text } = await mcpText('act', { session_id: sid, action: 'ACTION4', animation: 'all' });
  assert.match(text, /Animation of step 1: frame_count 2, 2 stored/);
  assert.match(text, /frame 0 \(full\):/);
  assert.match(text, /frame 1 \(diff, \d+ cells changed\):/);
  assert.ok(text.indexOf('Animation of step') > text.indexOf('frame_count 2'), 'the animation section comes last');
});

test('frame:"image" with animation:"all" writes one contact sheet of 2 tiles and keeps the board image', async (t) => {
  const { mcp, mcpText } = await startApp(t, FAST);
  const sid = await startGame(mcp);
  const r = ok(await mcp('act', { session_id: sid, action: 'ACTION4', frame: 'image', animation: 'all' }));
  assert.equal(r.frame.mode, 'image');
  assert.ok(existsSync(r.frame.path), 'the board image still exists');
  const a = r.animation;
  assert.ok(!('frames' in a));
  assert.ok(existsSync(a.image.path));
  assert.match(path.basename(a.image.path), /^anim-1-\d+\.png$/);
  const sheet = decodePng(await fs.readFile(a.image.path));
  const s = IMAGE_SPEC.sheet;
  const tile = 64 * s.scale_default + IMAGE_SPEC.grid.margin;
  assert.equal(sheet.width, s.gap + 2 * (tile + s.gap), 'two tiles in one row');
  const t2 = await mcpText('act', { session_id: sid, action: 'ACTION4', frame: 'image', animation: 'all' });
  assert.match(t2.text, /Board image: \S+\.png/);
  assert.match(t2.text, /Contact sheet: \S+anim-2-\d+\.png/);
});

test('observe returns an earlier step\'s animation equal to what act returned then; works after the session ended', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp);
  const first = ok(await mcp('act', { session_id: sid, action: 'ACTION4', animation: 'all' }));
  ok(await mcp('act', { session_id: sid, action: 'ACTION2' }));
  const later = ok(await mcp('observe', { session_id: sid, animation: 'all', animation_step: first.step, frame: 'none' }));
  assert.deepEqual(later.animation, first.animation);
  assert.equal(later.frame.mode, 'none');
  assert.equal(later.step, 2, 'observe reports the latest step, the animation names its own');
  const latest = ok(await mcp('observe', { session_id: sid, animation: 'all' }));
  assert.equal(latest.animation.step, 2, 'animation_step defaults to the latest step');
  await mcp('end_session', { session_id: sid });
  const ended = ok(await mcp('observe', { session_id: sid, animation: 'all', animation_step: first.step, frame: 'full' }));
  assert.deepEqual(ended.animation, first.animation);
  refusal(await mcp('observe', { session_id: sid, animation: 'all', frame: 'image' }), 'SESSION_ENDED');
});

test('the START step has one stored frame', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp);
  const r = ok(await mcp('observe', { session_id: sid, animation: 'all', animation_step: 0 }));
  assert.deepEqual([r.animation.stored, r.animation.omitted, r.animation.frames.length, r.animation.frames[0].mode], [1, 0, 1, 'full']);
});

test('argument refusals: unknown step, options without all, from past the end', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp);
  await mcp('act', { session_id: sid, action: 'ACTION4' });
  const unknown = refusal(await mcp('observe', { session_id: sid, animation: 'all', animation_step: 2 }), 'STEP_UNKNOWN');
  assert.deepEqual(unknown.details, { step: 1 });
  refusal(await mcp('observe', { session_id: sid, animation_step: 0 }), 'INVALID_ARGUMENT');
  refusal(await mcp('observe', { session_id: sid, animation_from: 0 }), 'INVALID_ARGUMENT');
  refusal(await mcp('observe', { session_id: sid, animation: 'last', animation_step: 0 }), 'INVALID_ARGUMENT');
  const past = refusal(await mcp('observe', { session_id: sid, animation: 'all', animation_from: 2 }), 'INVALID_ARGUMENT');
  assert.deepEqual(past.details, { frame_count: 2 });
  ok(await mcp('observe', { session_id: sid, animation: 'all', animation_from: 1 }));
});

test('fake-anim: act gives a first page of 16, paging through observe reaches the last index with the gap reported', async (t) => {
  const { mcp, mcpText } = await startApp(t, FAST);
  const sid = await startGame(mcp, 'fake-anim');
  const r = ok(await mcp('act', { session_id: sid, action: 'ACTION1', animation: 'all' }));
  const a = r.animation;
  assert.equal(r.frame_count, 70);
  assert.equal(a.frames.length, ANIMATION_PAGE_MAX);
  assert.deepEqual([a.truncated, a.next_from, a.stored, a.omitted], [true, ANIMATION_PAGE_MAX, ANIMATION_FRAMES_MAX, 70 - ANIMATION_FRAMES_MAX]);
  const indexes = a.frames.map((f) => f.index);
  let next = a.next_from;
  while (next !== null) {
    const p = ok(await mcp('observe', { session_id: sid, animation: 'all', animation_step: r.step, animation_from: next, frame: 'none' })).animation;
    assert.ok(p.frames.length <= ANIMATION_PAGE_MAX);
    assert.equal(p.frames[0].mode, 'full');
    indexes.push(...p.frames.map((f) => f.index));
    next = p.next_from;
  }
  assert.equal(indexes.length, ANIMATION_FRAMES_MAX);
  assert.equal(indexes.at(-1), 69);
  assert.deepEqual(indexes.slice(0, 63), [...Array(63).keys()], 'the first 63 frames are kept');
  assert.equal(indexes[63], 69, 'then the last, across the gap');
  const text = (await mcpText('act', { session_id: sid, action: 'ACTION1', animation: 'all' })).text;
  assert.match(text, /truncated:.*animation_step:2, animation_from:16/);
  const tail = (await mcpText('observe', { session_id: sid, animation: 'all', animation_step: 2, animation_from: 48, frame: 'none' })).text;
  assert.match(tail, /Frames 63-68 were not stored/);
});

test('a legacy session (old lines, frame_count 2, no anim_z) reports one stored frame with the notice', async (t) => {
  const env = await freshEnv(t);
  const sid = 's-00000000a1b2';
  const dir = path.join(env.dataDir, 'sessions', sid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
    id: sid, game_id: 'fake-maze', title: 'Fake Maze', mode: 'local', status: 'ended', end_reason: 'ended_by_agent', step_count: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', owner: { sessionId: null, project: null },
    last: { state: 'NOT_FINISHED', levels_completed: 0, win_levels: 2, available_actions: [1], frame_count: 2, full_reset: false },
  }));
  const rows = Array.from({ length: 64 }, () => '5'.repeat(64));
  const line = (n, count, zipped) => JSON.stringify({ n, action: n ? 'ACTION1' : 'START', frame_count: count, ...(zipped ? { frame_z: deflateRawSync(rows.join('\n')).toString('base64') } : { frame: rows }) });
  await fs.writeFile(path.join(dir, 'steps.jsonl'), `${line(0, 1, false)}\n${line(1, 2, true)}\n`);
  const { mcp, mcpText } = await startApp(t, { env });
  const a = ok(await mcp('observe', { session_id: sid, animation: 'all' })).animation;
  assert.deepEqual([a.stored, a.omitted, a.frames.length, a.frames[0].index], [1, 1, 1, 1]);
  const text = (await mcpText('observe', { session_id: sid, animation: 'all' })).text;
  assert.match(text, /Earlier frames were not recorded/);
});

test('observe with an animation is not a step: no rate slot, no step count change, no new line', async (t) => {
  const now = 1000;
  const { mcp, app } = await startApp(t, { stepRate: { max: 2, windowMs: 60000 }, clock: { now: () => now } });
  const sid = await startGame(mcp);
  await mcp('act', { session_id: sid, action: 'ACTION4' });
  const file = path.join(app.store.toolkitDir, '..', 'sessions', sid, 'steps.jsonl');
  const before = (await fs.readFile(file, 'utf8')).split('\n').length;
  const count = app.store.get(sid).step_count;
  for (let i = 0; i < 6; i++) ok(await mcp('observe', { session_id: sid, animation: 'all', animation_step: 1 }));
  assert.equal(app.store.get(sid).step_count, count);
  assert.equal((await fs.readFile(file, 'utf8')).split('\n').length, before);
  // Six observes would have spent a window of two; one slot is still left for a real step.
  ok(await mcp('act', { session_id: sid, action: 'ACTION4' }));
  refusal(await mcp('act', { session_id: sid, action: 'ACTION4' }), 'STEP_RATE_LIMITED');
});

test('a contact sheet clamps image_scale to sheet.scale_max; board images keep the full range', async (t) => {
  const { mcp } = await startApp(t, FAST);
  const sid = await startGame(mcp);
  const sheetAt = async (scale) => {
    const r = ok(await mcp('act', { session_id: sid, action: 'ACTION4', frame: 'image', image_scale: scale, animation: 'all' }));
    return { sheet: decodePng(await fs.readFile(r.animation.image.path)), board: decodePng(await fs.readFile(r.frame.path)) };
  };
  const max = await sheetAt(IMAGE_SPEC.sheet.scale_max);
  const over = await sheetAt(IMAGE_SPEC.scale.max);
  assert.ok(IMAGE_SPEC.scale.max > IMAGE_SPEC.sheet.scale_max);
  assert.deepEqual([over.sheet.width, over.sheet.height], [max.sheet.width, max.sheet.height]);
  assert.ok(over.board.width > max.board.width, 'the board image is not clamped');
});
