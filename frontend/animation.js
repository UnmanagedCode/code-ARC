// Viewer animation: when a multi-frame step is selected, its frames play once
// across the selection's duration (each frame lasts duration / frame_count),
// then the last frame holds. Pure (no DOM), driven by an injected clock so it
// is testable without real timers. It never touches pacing: a new selection
// cancels the running animation and starts its own.
// rows() is the frame to draw, or null for "draw the step's own last frame";
// holding is true while the frames load inside the window, meaning "keep
// whatever is on the canvas".

// One display frame: the shortest wait between two animation redraws.
export const FRAME_MIN_MS = 16;
// Steps whose frames are kept, per session.
const CACHE_MAX = 16;

// clock: { now(): ms, setTimeout(fn, ms): handle, clearTimeout(handle) }
// fetchFrames(n): Promise<{frame_count, stored, omitted, frames:[{index, rows}]}>
// onChange(): called after every change of what is shown.
export function createAnimation({ clock, fetchFrames, onChange }) {
  const cache = new Map(); // step n -> frames
  const inflight = new Map(); // step n -> Promise of frames (shared by prefetch and select)
  let epoch = 0; // bumped by reset: older fetches must not populate the cache
  let token = 0; // bumped by every selection: older selections must not show
  let step = null; // {n, frame_count} of the selected step
  let data = null; // the frames being played, or null
  let pos = -1; // index into data.frames; -1 = the step's own last frame
  let status = 'idle'; // idle | loading | ready | error
  let holding = false;
  let t0 = 0;
  let duration = 0;
  let timer = null;

  const cancel = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const remember = (n, got) => {
    cache.delete(n);
    cache.set(n, got);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  // One fetch per step n; a good result is cached unless the session changed.
  function fetchOnce(n) {
    if (inflight.has(n)) return inflight.get(n);
    const mine = epoch;
    const p = (async () => {
      try {
        const got = await fetchFrames(n);
        if (!got || !Array.isArray(got.frames) || got.frames.length === 0) throw new Error('no frames');
        if (mine === epoch) remember(n, got);
        return got;
      } finally {
        if (mine === epoch) inflight.delete(n);
      }
    })();
    inflight.set(n, p);
    return p;
  }

  // Shows the last stored frame due at the elapsed time and schedules the
  // wake for the next stored frame. Driven by elapsed time, so frames whose
  // slot has passed are skipped; the last frame is never dropped.
  function advance() {
    timer = null;
    const total = data.frame_count;
    const last = data.frames.length - 1;
    const elapsed = clock.now() - t0;
    // Within 1 ms of the end counts as the end: the final wake is clamped below.
    const slot = elapsed >= duration - 1 ? total - 1 : Math.floor((elapsed * total) / duration);
    let at = Math.max(pos, 0);
    while (at < last && data.frames[at + 1].index <= slot) at++;
    if (at !== pos) {
      pos = at;
      onChange();
    }
    if (at >= last) return;
    const due = t0 + (data.frames[at + 1].index * duration) / total;
    // Never later than 1 ms before the window ends, even if that is sooner than
    // FRAME_MIN_MS: the next selection (at t0 + duration) cancels this timer.
    const wait = Math.max(FRAME_MIN_MS, Math.ceil(due - clock.now()));
    timer = clock.setTimeout(advance, Math.min(wait, Math.max(0, t0 + duration - 1 - clock.now())));
  }

  function play(got) {
    data = got;
    pos = -1;
    status = 'ready';
    holding = false;
    advance();
  }

  return {
    get status() { return status; },
    get holding() { return holding; },
    // The hex rows to draw, or null for the step's own last frame.
    rows() { return data && pos >= 0 ? data.frames[pos].rows : null; },
    // Whether the step has frames to animate.
    get available() { return Boolean(step) && step.frame_count > 1; },
    // "frame i of N" by the toolkit's frame index; the last frame when not playing.
    get label() {
      if (!step) return '';
      const total = data ? data.frame_count : step.frame_count;
      const at = data && pos >= 0 ? data.frames[pos].index : total - 1;
      return `frame ${at} of ${total}`;
    },
    // Frames the store doesn't hold, known once the frames are loaded.
    get note() {
      if (!data || data.omitted <= 0) return '';
      return data.stored === 1
        ? 'earlier frames not recorded'
        : `frames ${data.stored - 1}-${data.frame_count - 2} not stored`;
    },

    // The session changed: forget everything, including fetches in flight.
    reset() {
      token++;
      epoch++;
      cancel();
      cache.clear();
      inflight.clear();
      step = null;
      data = null;
      pos = -1;
      holding = false;
      status = 'idle';
      onChange();
    },

    // A step was selected (always restarts, even the one already shown), to
    // play across durationMs. Duration 0, a single-frame step or null is static.
    select(next, durationMs) {
      const mine = ++token;
      cancel();
      step = next ? { n: next.n, frame_count: next.frame_count } : null;
      data = null;
      pos = -1;
      holding = false;
      status = 'idle';
      t0 = clock.now();
      duration = durationMs;
      if (!step || step.frame_count <= 1 || !(duration > 0)) {
        onChange();
        return;
      }
      const cached = cache.get(step.n);
      if (cached) {
        remember(step.n, cached);
        play(cached);
        return;
      }
      // Not ready: hold the canvas until the frames arrive or the window ends.
      status = 'loading';
      holding = true;
      const n = step.n;
      timer = clock.setTimeout(() => {
        timer = null;
        if (mine !== token) return;
        holding = false;
        status = 'idle';
        onChange();
      }, duration);
      fetchOnce(n).then(
        (got) => {
          if (mine !== token || !holding) return;
          cancel();
          play(got);
        },
        () => {
          if (mine !== token || !holding) return;
          cancel();
          holding = false;
          status = 'error';
          onChange();
        },
      );
      onChange();
    },

    // Warms the cache for a step that is likely selected next.
    prefetch(next) {
      if (!next || next.frame_count <= 1 || cache.has(next.n) || inflight.has(next.n)) return;
      fetchOnce(next.n).catch(() => {});
    },
  };
}
