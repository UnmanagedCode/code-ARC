// The viewer's animation replay (frontend/animation.js): pure, a fake clock and a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANIMATION_FRAME_MS, createAnimation } from '../frontend/animation.js';

function fakeClock() {
  let t = 0;
  const timers = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { const h = ++id; timers.set(h, { at: t + ms, fn }); return h; },
    clearTimeout(h) { timers.delete(h); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

const data = (indexes, frameCount = indexes.at(-1) + 1) => ({
  frame_count: frameCount, stored: indexes.length, omitted: frameCount - indexes.length,
  frames: indexes.map((index) => ({ index, rows: [`r${index}`] })),
});

function setup(responder = (n) => Promise.resolve(data([0, 1, 2]))) {
  const clock = fakeClock();
  const fetched = [];
  let changes = 0;
  const anim = createAnimation({ clock, fetchFrames: (n) => { fetched.push(n); return responder(n); }, onChange: () => { changes++; } });
  return { anim, clock, fetched, changes: () => changes };
}
const flush = () => new Promise((r) => setImmediate(r));

test('show resets to the step\'s own last frame and fetches nothing', () => {
  const { anim, fetched } = setup();
  anim.show({ n: 3, frame_count: 3 });
  assert.equal(anim.rows(), null, 'draw step.frame');
  assert.equal(anim.available, true);
  assert.equal(anim.label, 'frame 2 of 3');
  anim.show({ n: 4, frame_count: 1 });
  assert.equal(anim.available, false, 'a single-frame step has no controls');
  assert.deepEqual(fetched, []);
});

test('play fetches once per step, runs from the first to the last frame at the toolkit pace, then stops', async () => {
  const { anim, clock, fetched } = setup();
  anim.show({ n: 1, frame_count: 3 });
  await anim.play();
  assert.deepEqual(fetched, [1]);
  assert.equal(anim.playing, true);
  assert.deepEqual(anim.rows(), ['r0']);
  clock.advance(ANIMATION_FRAME_MS - 1);
  assert.deepEqual(anim.rows(), ['r0'], 'not yet');
  clock.advance(1);
  assert.deepEqual(anim.rows(), ['r1']);
  clock.advance(ANIMATION_FRAME_MS);
  assert.deepEqual(anim.rows(), ['r2']);
  assert.equal(anim.playing, false, 'stops on the last frame');
  assert.equal(clock.pending(), 0);
  assert.equal(anim.played, true);
  await anim.play();
  assert.deepEqual(fetched, [1], 'a replay uses the loaded frames');
  assert.deepEqual(anim.rows(), ['r0']);
});

test('stepBy moves one frame, pauses, and clamps at both ends', async () => {
  const { anim, clock } = setup();
  anim.show({ n: 1, frame_count: 3 });
  await anim.stepBy(-1);
  assert.equal(anim.label, 'frame 1 of 3', 'from the last frame, one back');
  await anim.stepBy(-1);
  await anim.stepBy(-1);
  assert.equal(anim.label, 'frame 0 of 3', 'clamped at the first');
  await anim.stepBy(1);
  await anim.stepBy(1);
  await anim.stepBy(1);
  assert.equal(anim.label, 'frame 2 of 3', 'clamped at the last');
  await anim.play();
  await anim.stepBy(-1);
  assert.equal(anim.playing, false, 'stepping pauses');
  clock.advance(10 * ANIMATION_FRAME_MS);
  assert.equal(clock.pending(), 0, 'no timer keeps running');
});

test('labels use the toolkit index across a gap, and the note says what is missing', async () => {
  const { anim } = setup(() => Promise.resolve(data([0, 1, 2, 69], 70)));
  anim.show({ n: 1, frame_count: 70 });
  await anim.stepBy(-1);
  assert.equal(anim.label, 'frame 2 of 70');
  assert.equal(anim.note, 'frames 3-68 not stored');
  await anim.stepBy(1);
  assert.equal(anim.label, 'frame 69 of 70');
  const one = setup(() => Promise.resolve(data([1], 2)));
  one.anim.show({ n: 1, frame_count: 2 });
  await one.anim.stepBy(-1);
  assert.equal(one.anim.note, 'earlier frames not recorded');
});

test('a fetch that resolves after the step changed is discarded', async () => {
  let release;
  const { anim } = setup(() => new Promise((r) => { release = r; }));
  anim.show({ n: 1, frame_count: 3 });
  const pending = anim.play();
  anim.show({ n: 2, frame_count: 2 });
  release(data([0, 1, 2]));
  await pending;
  assert.equal(anim.playing, false);
  assert.equal(anim.rows(), null, 'step 2 still shows its own frame');
  assert.equal(anim.label, 'frame 1 of 2');
});

test('a fetch error sets status error and a later play retries', async () => {
  let fail = true;
  const { anim, fetched } = setup(() => (fail ? Promise.reject(new Error('HTTP 404')) : Promise.resolve(data([0, 1]))));
  anim.show({ n: 1, frame_count: 2 });
  await anim.play();
  assert.equal(anim.status, 'error');
  assert.equal(anim.playing, false);
  assert.equal(anim.rows(), null);
  fail = false;
  await anim.play();
  assert.equal(anim.status, 'ready');
  assert.deepEqual(fetched, [1, 1]);
});

test('showing the same step again keeps its state; reset clears the cache', async () => {
  const { anim, fetched } = setup();
  anim.show({ n: 1, frame_count: 3 });
  await anim.stepBy(-1);
  anim.show({ n: 1, frame_count: 3 });
  assert.equal(anim.label, 'frame 1 of 3');
  anim.show({ n: 2, frame_count: 3 });
  anim.show({ n: 1, frame_count: 3 });
  assert.equal(anim.status, 'ready', 'cached frames come back without a fetch');
  assert.deepEqual(fetched, [1]);
  anim.reset();
  anim.show({ n: 1, frame_count: 3 });
  assert.equal(anim.status, 'idle');
});
