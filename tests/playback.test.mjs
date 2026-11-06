// Paced live follow and Replay, on a fake clock (no real timers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback, DEFAULT_INTERVAL_MS } from '../frontend/playback.js';

const I = DEFAULT_INTERVAL_MS;

function setup() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { timers.set(++seq, { at: t + ms, fn }); return seq; },
    clearTimeout: (h) => { timers.delete(h); },
    pending: () => timers.size,
    // Fires due timers in time order, moving `now` to each.
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = end;
    },
  };
  let changes = 0;
  const pb = createPlayback({ clock, onChange: () => { changes++; } });
  return { clock, pb, changes: () => changes };
}

// Pins: every live step is shown, in order, each held >= the interval.
test('a live burst shows every step in order, one per interval', () => {
  const { clock, pb } = setup();
  pb.load(1, 0, 'live');
  for (let k = 0; k < 10; k++) pb.append();
  assert.equal(pb.cursor, 0);
  assert.equal(pb.behind, 10);
  for (let k = 1; k <= 10; k++) {
    clock.advance(I - 1);
    assert.equal(pb.cursor, k - 1, 'not early');
    clock.advance(1);
    assert.equal(pb.cursor, k);
    assert.equal(pb.behind, 10 - k);
  }
  assert.equal(clock.pending(), 0);
});

// Pins: no extra delay when the previous step has been shown >= the interval.
test('the first step of a burst after idle shows at once', () => {
  const { clock, pb } = setup();
  pb.load(1, 0, 'live');
  clock.advance(2000);
  pb.append();
  assert.equal(pb.cursor, 1);
  assert.equal(clock.pending(), 0);
});

// Pins: steps arriving slower than the interval show as they arrive.
test('slow arrivals show at their arrival time', () => {
  const { clock, pb } = setup();
  pb.load(1, 0, 'live');
  for (let k = 1; k <= 4; k++) {
    clock.advance(800);
    pb.append();
    assert.equal(pb.cursor, k);
    assert.equal(pb.behind, 0);
  }
});

// Pins: Jump to latest catches up and stops pacing.
test('jumpToLatest mid-burst catches up with nothing left pending', () => {
  const { clock, pb } = setup();
  pb.load(1, 0, 'live');
  for (let k = 0; k < 10; k++) pb.append();
  clock.advance(I);
  pb.jumpToLatest();
  assert.equal(pb.cursor, 10);
  assert.equal(pb.behind, 0);
  assert.equal(pb.mode, 'live');
  clock.advance(10 * I);
  assert.equal(pb.cursor, 10);
  assert.equal(clock.pending(), 0);
});

// Pins: the viewer cap never desyncs the cursor from the steps.
test('trim while behind keeps behind and the cursor in range', () => {
  const { clock, pb } = setup();
  pb.load(5, 4, 'live');
  pb.append();
  pb.append();
  assert.equal(pb.behind, 2);
  pb.trim();
  assert.equal(pb.behind, 2);
  assert.equal(pb.cursor, 3);
  const z = setup();
  z.pb.load(1, 0, 'live');
  z.pb.append();
  z.pb.trim();
  assert.equal(z.pb.cursor, 0);
  clock.advance(5 * I);
  assert.equal(pb.behind, 0);
});

// Pins: Play advances per interval and stops at the end.
test('replay play from the middle steps once per interval and stops at the end', () => {
  const { clock, pb } = setup();
  pb.load(6, 5, 'replay');
  pb.seek(2);
  pb.play();
  assert.equal(pb.mode, 'replay');
  assert.equal(pb.playing, true);
  clock.advance(I);
  assert.equal(pb.cursor, 3);
  clock.advance(I);
  assert.equal(pb.cursor, 4);
  clock.advance(I);
  assert.equal(pb.cursor, 5);
  assert.equal(pb.playing, false);
  assert.equal(clock.pending(), 0);
});

// Pins: Pause holds the position; Play resumes from it.
test('pause mid-play holds the cursor and play resumes from it', () => {
  const { clock, pb } = setup();
  pb.load(10, 0, 'replay');
  pb.play();
  clock.advance(I * 2);
  assert.equal(pb.cursor, 2);
  pb.pause();
  clock.advance(I * 10);
  assert.equal(pb.cursor, 2);
  assert.equal(pb.playing, false);
  pb.play();
  assert.equal(pb.cursor, 3, 'resumes from the held step; it was already shown for the interval');
  clock.advance(I);
  assert.equal(pb.cursor, 4);
});

// Pins: Play at the end restarts from the first step.
test('play at the end restarts at step 0, then advances', () => {
  const { clock, pb } = setup();
  pb.load(4, 3, 'replay');
  pb.play();
  assert.equal(pb.cursor, 0);
  assert.equal(pb.playing, true);
  clock.advance(I);
  assert.equal(pb.cursor, 1);
});

// Pins: manual navigation enters Replay, paused, in range.
test('seek while live or playing enters a paused replay, clamped', () => {
  const { clock, pb } = setup();
  pb.load(10, 9, 'live');
  pb.seek(3);
  assert.equal(pb.mode, 'replay');
  assert.equal(pb.cursor, 3);
  pb.play();
  pb.seek(99);
  assert.equal(pb.cursor, 9);
  assert.equal(pb.playing, false);
  pb.seek(-4);
  assert.equal(pb.cursor, 0);
  clock.advance(10 * I);
  assert.equal(pb.cursor, 0);
});

// Pins: switching back to Live resumes paced following at the newest step.
test('setMode live from replay jumps to the newest step; later appends are paced', () => {
  const { clock, pb } = setup();
  pb.load(10, 9, 'live');
  pb.seek(2);
  pb.setMode('live');
  assert.equal(pb.cursor, 9);
  assert.equal(pb.mode, 'live');
  pb.append();
  pb.append();
  assert.equal(pb.cursor, 9);
  clock.advance(I);
  assert.equal(pb.cursor, 10);
  clock.advance(I);
  assert.equal(pb.cursor, 11);
});

// Pins: replay follows arrivals only while playing.
test('append in a paused replay keeps the cursor; a playing replay runs on through it', () => {
  const { clock, pb } = setup();
  pb.load(5, 1, 'replay');
  pb.append();
  clock.advance(10 * I);
  assert.equal(pb.cursor, 1);
  pb.play();
  clock.advance(I);
  pb.append();
  clock.advance(10 * I);
  assert.equal(pb.cursor, 6);
  assert.equal(pb.playing, false);
});

// Pins: one interval governs both modes and applies to a pending advance.
test('setIntervalMs reschedules a pending advance from when the step was shown', () => {
  const { clock, pb } = setup();
  pb.load(1, 0, 'live');
  pb.append();
  pb.setIntervalMs(2000);
  clock.advance(1999);
  assert.equal(pb.cursor, 0);
  clock.advance(1);
  assert.equal(pb.cursor, 1);

  const o = setup();
  o.pb.load(1, 0, 'live');
  o.pb.append();
  o.clock.advance(400);
  o.pb.setIntervalMs(100);
  assert.equal(o.pb.cursor, 1, 'already overdue: immediate');
});

// Pins: the render hook is never missed.
test('onChange fires on every cursor, mode and playing change', () => {
  const { clock, pb, changes } = setup();
  const step = (fn) => { const before = changes(); fn(); assert.ok(changes() > before); };
  step(() => pb.load(5, 0, 'live'));
  step(() => pb.append());
  step(() => clock.advance(I));
  step(() => pb.setMode('replay'));
  step(() => pb.play());
  step(() => pb.pause());
  step(() => pb.seek(1));
  step(() => pb.jumpToLatest());
  step(() => pb.setMode('live'));
  step(() => pb.setIntervalMs(250));
  step(() => pb.trim());
});
