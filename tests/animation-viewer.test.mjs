// The viewer's step animation (frontend/animation.js): pure, a fake clock and a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_MIN_MS, createAnimation } from '../frontend/animation.js';

function fakeClock() {
  let t = 0;
  const timers = new Map();
  const delays = [];
  let id = 0;
  return {
    now: () => t,
    setTimeout(fn, ms) { const h = ++id; delays.push(ms); timers.set(h, { at: t + ms, fn }); return h; },
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
    delays,
  };
}

const data = (indexes, frameCount = indexes.at(-1) + 1) => ({
  frame_count: frameCount, stored: indexes.length, omitted: frameCount - indexes.length,
  frames: indexes.map((index) => ({ index, rows: [`r${index}`] })),
});
const all = (n) => data([...Array(n).keys()]);

// responder(n) -> Promise of frames; onChange observers see the clock time.
function setup(responder = () => Promise.resolve(all(10)), observe = () => {}) {
  const clock = fakeClock();
  const fetched = [];
  let changes = 0;
  let anim;
  anim = createAnimation({
    clock,
    fetchFrames: (n) => { fetched.push(n); return responder(n); },
    onChange: () => { changes++; observe(anim, clock.now()); },
  });
  return { anim, clock, fetched, changes: () => changes };
}
const flush = () => new Promise((r) => setImmediate(r));
const step = (n, frame_count = 10) => ({ n, frame_count });

// Invariant: each frame lasts duration / frame_count (R2).
test('frame duration is interval / frame_count: 10 frames over 500 ms change every 50 ms', async () => {
  const { anim, clock } = setup();
  anim.select(step(1), 500);
  await flush();
  assert.deepEqual(anim.rows(), ['r0'], 'frame 0 at t0');
  clock.advance(49);
  assert.deepEqual(anim.rows(), ['r0']);
  for (let i = 1; i < 10; i++) {
    clock.advance(i === 1 ? 1 : 50);
    assert.deepEqual(anim.rows(), [`r${i}`], `frame ${i}`);
  }
  assert.equal(anim.label, 'frame 9 of 10');
});

// Invariant: an animation plays once per selection and holds on the last frame; nothing keeps running (R1).
test('plays once then holds on the last frame with no timer and no further changes', async () => {
  const { anim, clock, changes } = setup();
  anim.select(step(1), 500);
  await flush();
  clock.advance(500);
  assert.deepEqual(anim.rows(), ['r9']);
  const after = changes();
  clock.advance(5000);
  assert.deepEqual(anim.rows(), ['r9']);
  assert.equal(clock.pending(), 0);
  assert.equal(changes(), after);
});

// Invariant: selecting the shown step again replays it from the cache (R1).
test('selecting the same step again replays from frame 0 without a new fetch', async () => {
  const { anim, clock, fetched } = setup();
  anim.select(step(1), 500);
  await flush();
  clock.advance(600);
  anim.select(step(1), 500);
  assert.deepEqual(anim.rows(), ['r0'], 'synchronously from the cache');
  assert.deepEqual(fetched, [1]);
  clock.advance(500);
  assert.deepEqual(anim.rows(), ['r9']);
});

// Invariant: a new selection cancels the running animation (R3).
test('selecting another step mid-animation cancels the old one', async () => {
  const { anim, clock } = setup((n) => Promise.resolve(data([...Array(10).keys()].map((i) => i))));
  anim.select(step(1), 500);
  await flush();
  clock.advance(120);
  anim.select(step(2), 500);
  await flush();
  assert.deepEqual(anim.rows(), ['r0'], 'the new step starts at its frame 0');
  assert.equal(clock.pending(), 1, 'only the new step\'s timer');
  clock.advance(500);
  assert.equal(anim.label, 'frame 9 of 10');
  assert.equal(clock.pending(), 0);
  anim.select(step(3, 1), 500);
  assert.equal(clock.pending(), 0, 'a single-frame step leaves no timer');
});

// Invariant: playback is elapsed-time driven; frames are dropped, never the last, never faster than a display frame (R2, R4).
test('frame dropping: stored gap, wakes no sooner than FRAME_MIN_MS, shown index follows the elapsed-time formula, ends on the last frame', async () => {
  const stored = [...Array(63).keys(), 69];
  const seen = [];
  const { anim, clock, changes } = setup(() => Promise.resolve(data(stored, 70)), (a, now) => {
    seen.push([now, Number(a.label.match(/frame (\d+)/)[1])]);
  });
  anim.select(step(1, 70), 100);
  await flush();
  for (let t = 0; t < 130; t++) clock.advance(1);
  // Every wake waits a display frame, except the final one, clamped to the window end.
  assert.ok(clock.delays.slice(0, -1).every((d) => d >= FRAME_MIN_MS), `delays ${clock.delays}`);
  for (const [now, index] of seen) {
    const slot = now >= 100 ? 69 : Math.floor((now * 70) / 100);
    const expected = Math.max(...stored.filter((i) => i <= slot));
    if (now > 0) assert.equal(index, expected, `at ${now} ms`);
  }
  assert.equal(anim.label, 'frame 69 of 70');
  assert.ok(seen.find(([, index]) => index === 69)[0] <= 100, 'the last frame is shown by t0 + D');
  assert.ok(changes() <= Math.ceil(100 / FRAME_MIN_MS) + 2, `${changes()} changes`);
  assert.equal(anim.note, 'frames 63-68 not stored');
});

test('frame 62 holds through the storage gap', async () => {
  const stored = [...Array(63).keys(), 69];
  const { anim, clock } = setup(() => Promise.resolve(data(stored, 70)));
  anim.select(step(1, 70), 7000); // 100 ms per frame
  await flush();
  clock.advance(6500); // slot 65, inside the gap
  assert.equal(anim.label, 'frame 62 of 70');
  clock.advance(500);
  assert.equal(anim.label, 'frame 69 of 70');
});

// Invariant: while frames load inside the window the canvas is held, then the remaining timeline plays and still ends at t0 + D (R5c).
test('fetch not ready: holds, then plays the rest from the elapsed slot when frames arrive in the window', async () => {
  let release;
  const { anim, clock } = setup(() => new Promise((r) => { release = r; }));
  anim.select(step(1), 500);
  assert.equal(anim.holding, true);
  assert.equal(anim.rows(), null);
  assert.equal(anim.status, 'loading');
  clock.advance(200);
  assert.equal(anim.holding, true);
  release(all(10));
  await flush();
  assert.equal(anim.holding, false);
  assert.deepEqual(anim.rows(), ['r4'], 'shortened: starts at the elapsed slot');
  clock.advance(249);
  assert.deepEqual(anim.rows(), ['r8']);
  clock.advance(1);
  assert.deepEqual(anim.rows(), ['r9'], 'still ends at t0 + D');
  assert.equal(clock.pending(), 0);
});

// Invariant: a fetch that misses the window falls back to the step's own frame and never starts late (R5d).
test('fetch not ready by the window end: shows the step\'s own frame; the late arrival is cached, not played', async () => {
  let release;
  const { anim, clock, fetched } = setup(() => new Promise((r) => { release = r; }));
  anim.select(step(1), 500);
  clock.advance(500);
  assert.equal(anim.holding, false);
  assert.equal(anim.rows(), null);
  release(all(10));
  await flush();
  assert.equal(anim.rows(), null, 'does not animate late');
  assert.equal(clock.pending(), 0);
  anim.select(step(1), 500);
  assert.deepEqual(anim.rows(), ['r0'], 'the next selection plays from the cache');
  assert.deepEqual(fetched, [1]);
});

// Invariant: a failed fetch shows the step's own frame, is not cached, and the next selection retries (R5d).
test('fetch error: status error, no hold, and reselecting refetches', async () => {
  let fail = true;
  const { anim, fetched } = setup(() => (fail ? Promise.reject(new Error('HTTP 404')) : Promise.resolve(all(10))));
  anim.select(step(1), 500);
  await flush();
  assert.equal(anim.status, 'error');
  assert.equal(anim.holding, false);
  assert.equal(anim.rows(), null);
  fail = false;
  anim.select(step(1), 500);
  await flush();
  assert.equal(anim.status, 'ready');
  assert.deepEqual(fetched, [1, 1]);
});

// Invariant: prefetch and select share one fetch; a prefetched step starts with no hold (R5a, R5b).
test('prefetch then select fetches once and shows frame 0 synchronously', async () => {
  const { anim, fetched } = setup();
  anim.prefetch(step(2));
  anim.prefetch(step(2));
  assert.deepEqual(fetched, [2], 'deduped while in flight');
  await flush();
  anim.select(step(2), 500);
  assert.equal(anim.holding, false);
  assert.deepEqual(anim.rows(), ['r0']);
  assert.deepEqual(fetched, [2]);
  anim.prefetch(step(2));
  anim.prefetch(step(3, 1));
  anim.prefetch(undefined);
  assert.deepEqual(fetched, [2], 'cached, single-frame and missing steps are not fetched');
});

test('prefetch in flight when selected is shared, not refetched', async () => {
  let release;
  const { anim, fetched } = setup(() => new Promise((r) => { release = r; }));
  anim.prefetch(step(2));
  anim.select(step(2), 500);
  assert.deepEqual(fetched, [2]);
  release(all(10));
  await flush();
  assert.deepEqual(anim.rows(), ['r0']);
});

// Invariant: a scrubbing (duration 0) or single-frame selection is static: no fetch, no timer, no hold (R6).
test('duration 0 and single-frame steps are static', () => {
  const { anim, clock, fetched } = setup();
  anim.select(step(1), 0);
  assert.equal(anim.rows(), null);
  assert.equal(anim.holding, false);
  assert.equal(anim.label, 'frame 9 of 10');
  anim.select(step(2, 1), 500);
  assert.equal(anim.available, false);
  anim.select(null, 500);
  assert.equal(anim.label, '');
  assert.deepEqual(fetched, []);
  assert.equal(clock.pending(), 0);
});

// Invariant: reset (session change) drops the cache and ignores older in-flight fetches.
test('reset clears the cache and a pre-reset fetch landing later does not populate it', async () => {
  let release;
  const { anim, fetched } = setup(() => new Promise((r) => { release = r; }));
  anim.prefetch(step(1));
  anim.reset();
  release(all(10));
  await flush();
  anim.select(step(1), 500);
  assert.equal(anim.holding, true, 'not cached: fetched again');
  assert.deepEqual(fetched, [1, 1]);
});

// Invariant: the label uses the toolkit index across a gap and the note says what is missing.
test('labels use the toolkit index across a gap, and the note says what is missing', async () => {
  const { anim, clock } = setup(() => Promise.resolve(data([0, 1, 2, 69], 70)));
  anim.select(step(1, 70), 7000);
  await flush();
  assert.equal(anim.note, 'frames 3-68 not stored');
  clock.advance(500);
  assert.equal(anim.label, 'frame 2 of 70');
  clock.advance(7000);
  assert.equal(anim.label, 'frame 69 of 70');
  const one = setup(() => Promise.resolve(data([1], 2)));
  one.anim.select(step(1, 2), 500);
  await flush();
  assert.equal(one.anim.note, 'earlier frames not recorded');
});

// Invariant: the last frame is drawn before the window ends, i.e. before the
// next selection (at t0 + D) cancels the timer (R4); also at long frame counts.
test('the last frame is shown before t0 + D even when the minimum wait would overshoot', async () => {
  for (const [frames, ms] of [[70, 100], [200, 500]]) {
    const { anim, clock } = setup(() => Promise.resolve(all(frames)));
    anim.select(step(1, frames), ms);
    await flush();
    clock.advance(ms - 1);
    assert.equal(anim.label, `frame ${frames - 1} of ${frames}`, `${frames} frames in ${ms} ms`);
    assert.equal(clock.pending(), 0);
  }
});

const dataP = (prefix, indexes, frameCount) => ({
  frame_count: frameCount, stored: indexes.length, omitted: frameCount - indexes.length,
  frames: indexes.map((index) => ({ index, rows: [`${prefix}${index}`] })),
});

// Invariant: a fetch result or timeout of an older selection never touches the newer one (token guards).
function twoSlowSteps(clock) {
  const pend = {};
  const { anim } = setup((n) => new Promise((resolve, reject) => { pend[n] = { resolve, reject }; }));
  return { anim, pend };
}
const ownsB = (anim) => {
  assert.equal(anim.holding, true, 'B still holds');
  assert.equal(anim.rows(), null);
  assert.equal(anim.status, 'loading');
  assert.equal(anim.note, '');
  assert.equal(anim.label, 'frame 3 of 4');
};

test('a stale fetch success of step A does not show on step B', async () => {
  const { anim, pend } = twoSlowSteps();
  anim.select(step(1, 3), 500);
  anim.select(step(2, 4), 500);
  pend[1].resolve(dataP('a', [0, 2], 3)); // omitted: its note must not leak either
  await flush();
  ownsB(anim);
  pend[2].resolve(dataP('b', [0, 1, 2, 3], 4));
  await flush();
  assert.deepEqual(anim.rows(), ['b0']);
  assert.equal(anim.status, 'ready');
});

test('a stale fetch error of step A does not mark step B as failed', async () => {
  const { anim, pend } = twoSlowSteps();
  anim.select(step(1, 3), 500);
  anim.select(step(2, 4), 500);
  pend[1].reject(new Error('HTTP 500'));
  await flush();
  ownsB(anim);
  pend[2].resolve(dataP('b', [0, 1, 2, 3], 4));
  await flush();
  assert.deepEqual(anim.rows(), ['b0']);
});

test('a stale hold timeout of step A does not end step B\'s hold', () => {
  // A clock that lets cleared timers fire anyway, so only the guard can stop them.
  let t = 0;
  const timers = [];
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { timers.push({ at: t + ms, fn }); return timers.length; },
    clearTimeout: () => {},
  };
  const anim = createAnimation({ clock, fetchFrames: () => new Promise(() => {}), onChange: () => {} });
  const run = (to) => { t = to; for (const x of timers.filter((x) => x.at <= to && !x.done)) { x.done = true; x.fn(); } };
  anim.select(step(1, 3), 500);
  run(300);
  anim.select(step(2, 4), 500); // B's window ends at 800
  run(600); // A's timeout (500) fires now
  ownsB(anim);
  run(800);
  assert.equal(anim.holding, false, 'B\'s own timeout still ends its hold');
});
