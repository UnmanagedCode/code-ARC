// The pure animation views (src/animation.js): indexes, paging, first-full-then-diffs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { animationData, animationText, stepFrames } from '../src/animation.js';
import { ANIMATION_PAGE_MAX } from '../src/limits.js';

const frame = (digit, w = 3) => ['0'.repeat(w).replace(/0/g, digit), '0'.repeat(w)];
// Frame i differs from frame i-1 in one cell of row 0.
const frames = (n, w = 3) => Array.from({ length: n }, (_, i) => [String(i % 10).padEnd(w, '0'), '0'.repeat(w)]);

const src = (n, over = {}) => {
  const all = frames(n);
  return { step: 4, anim: all.slice(0, -1), frame: all.at(-1), frame_count: n, ...over };
};

test('indexes: leading frames 0..k-1, the last frame frame_count-1, so a gap is a jump', () => {
  const seq = stepFrames({ anim: frames(3), frame: frame('9'), frame_count: 70 });
  assert.deepEqual(seq.frames.map((f) => f.index), [0, 1, 2, 69]);
  assert.equal(seq.stored, 4);
  assert.equal(seq.omitted, 66);
});

test('a step stored without leading frames gives just its last frame, the rest omitted', () => {
  const seq = stepFrames({ anim: undefined, frame: frame('9'), frame_count: 2 });
  assert.deepEqual(seq.frames.map((f) => f.index), [1]);
  assert.equal(seq.omitted, 1);
  assert.deepEqual(stepFrames({ anim: null, frame: frame('9'), frame_count: 1 }).frames.map((f) => f.index), [0]);
});

test('no frame (a terminal step) gives no frames', () => {
  assert.deepEqual(stepFrames({ anim: [], frame: null, frame_count: 0 }), { frames: [], stored: 0, omitted: 0 });
  const d = animationData({ step: 9, anim: [], frame: null, frame_count: 0 });
  assert.deepEqual(d.frames, []);
  assert.equal(d.truncated, false);
});

test('a page holds at most ANIMATION_PAGE_MAX frames; next_from continues exactly where it stopped', () => {
  const s = src(ANIMATION_PAGE_MAX + 5);
  const first = animationData(s);
  assert.equal(first.frames.length, ANIMATION_PAGE_MAX);
  assert.equal(first.truncated, true);
  assert.equal(first.next_from, ANIMATION_PAGE_MAX);
  const second = animationData(s, { from: first.next_from });
  assert.deepEqual(second.frames.map((f) => f.index), [16, 17, 18, 19, 20]);
  assert.equal(second.truncated, false);
  assert.equal(second.next_from, null);
});

test('exactly one page is not truncated', () => {
  const d = animationData(src(ANIMATION_PAGE_MAX));
  assert.equal(d.frames.length, ANIMATION_PAGE_MAX);
  assert.equal(d.truncated, false);
});

test('paging across the gap: next_from is the next stored index, not index+1', () => {
  const s = { step: 1, anim: frames(15), frame: frame('7'), frame_count: 100 };
  const first = animationData(s, { from: 14 });
  assert.deepEqual(first.frames.map((f) => f.index), [14, 99]);
  const mid = animationData({ ...s, anim: frames(16) }, {});
  assert.equal(mid.next_from, 99);
});

test('the first frame of a page is full; each later one is a diff against the frame before it', () => {
  const d = animationData(src(3), { from: 0 });
  assert.equal(d.frames[0].mode, 'full');
  assert.deepEqual(d.frames[0].rows, frames(3)[0]);
  assert.equal(d.frames[1].mode, 'diff');
  assert.equal(d.frames[1].changed_cells, 1);
  assert.deepEqual(d.frames[1].changed_rows, [{ y: 0, row: frames(3)[1][0] }]);
  // Frame 2 is diffed against frame 1, not against frame 0.
  assert.deepEqual(d.frames[2].changed_rows, [{ y: 0, row: frames(3)[2][0] }]);
  const later = animationData(src(3), { from: 1 });
  assert.equal(later.frames[0].mode, 'full', 'a later page starts with a full frame');
});

test('a change of shape between frames is sent full with auto_full', () => {
  const d = animationData({ step: 2, anim: [['00', '00']], frame: ['000', '000', '000'], frame_count: 2 });
  assert.equal(d.frames[1].mode, 'full');
  assert.equal(d.frames[1].auto_full, true);
});

test('text: names animation_from with its value when truncated', () => {
  const t = animationText(src(ANIMATION_PAGE_MAX + 5));
  assert.match(t, /truncated:/);
  assert.match(t, new RegExp(`animation_step:4, animation_from:${ANIMATION_PAGE_MAX}`));
  assert.doesNotMatch(animationText(src(3)), /truncated:/);
});

test('text: the gap and the not-recorded notices', () => {
  const gap = animationText({ step: 2, anim: frames(63), frame: frame('5'), frame_count: 70 }, { from: 62 });
  assert.match(gap, /Frames 63-68 were not stored/);
  const single = animationText({ step: 2, anim: undefined, frame: frame('5'), frame_count: 2 });
  assert.match(single, /Earlier frames were not recorded/);
  assert.doesNotMatch(animationText(src(3)), /not stored|not recorded/);
});

test('text: full frame first, diffs after, labelled with the toolkit frame index', () => {
  const t = animationText(src(2));
  assert.match(t, /frame 0 \(full\):/);
  assert.match(t, /frame 1 \(diff, 1 cells changed\):/);
});

test('text: a step with no readable frame says so, with no bogus range', () => {
  const t = animationText({ step: 5, anim: undefined, frame: null, frame_count: 3 });
  assert.match(t, /No readable frames were recorded for this step \(frame_count 3\)/);
  assert.doesNotMatch(t, /-1|were not stored/);
});

test('omitted follows frame_count - stored even when the last frame is missing', () => {
  assert.deepEqual(stepFrames({ anim: [], frame: null, frame_count: 3 }), { frames: [], stored: 0, omitted: 3 });
});
