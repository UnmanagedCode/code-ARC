// Viewer playback: which step is shown and how the cursor advances. Pure (no
// DOM), driven by an injected clock so it is testable without real timers.
// Live mode holds every step on screen for at least the interval, however
// fast steps arrive; Replay mode steps through history on Play.

// The interval choices the UI offers.
export const INTERVALS_MS = [100, 250, 500, 1000, 2000];
export const DEFAULT_INTERVAL_MS = 500;

// clock: { now(): ms, setTimeout(fn, ms): handle, clearTimeout(handle) }
// onChange(): called after every change of mode, playing, cursor, count or interval.
export function createPlayback({ clock, onChange }) {
  let mode = 'live';
  let playing = false;
  let cursor = -1;
  let count = 0;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let lastShownAt = clock.now();
  let timer = null;

  const cancel = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  function pump() {
    if (timer !== null) return;
    if (!(mode === 'live' || playing) || cursor >= count - 1) return;
    const wait = lastShownAt + intervalMs - clock.now();
    if (wait <= 0) tick();
    else timer = clock.setTimeout(tick, wait);
  }

  function tick() {
    timer = null;
    cursor++;
    lastShownAt = clock.now();
    if (mode === 'replay' && cursor === count - 1) playing = false;
    onChange();
    pump();
  }

  return {
    get mode() { return mode; },
    get playing() { return playing; },
    get cursor() { return cursor; },
    get count() { return count; },
    get intervalMs() { return intervalMs; },
    get behind() { return mode === 'live' ? Math.max(0, count - 1 - cursor) : 0; },

    load(n, at, m) {
      cancel();
      count = n;
      cursor = at;
      mode = m;
      playing = false;
      lastShownAt = clock.now();
      onChange();
    },
    append() {
      count++;
      pump();
      onChange();
    },
    // The oldest step was dropped at the viewer cap.
    trim() {
      count--;
      if (cursor > 0) cursor--;
      onChange();
    },
    setMode(m) {
      cancel();
      playing = false;
      mode = m;
      if (m === 'live') {
        cursor = count - 1;
        lastShownAt = clock.now();
      }
      onChange();
    },
    play() {
      mode = 'replay';
      if (count < 2) {
        playing = false;
        onChange();
        return;
      }
      playing = true;
      if (cursor >= count - 1) {
        cursor = 0;
        lastShownAt = clock.now();
      }
      pump();
      onChange();
    },
    pause() {
      playing = false;
      cancel();
      onChange();
    },
    // Manual navigation always lands in a paused Replay.
    seek(i) {
      mode = 'replay';
      playing = false;
      cancel();
      cursor = count ? Math.max(0, Math.min(count - 1, i)) : -1;
      lastShownAt = clock.now();
      onChange();
    },
    jumpToLatest() {
      cancel();
      cursor = count - 1;
      lastShownAt = clock.now();
      onChange();
    },
    setIntervalMs(ms) {
      intervalMs = ms;
      cancel();
      pump();
      onChange();
    },
    dispose() { cancel(); },
  };
}
