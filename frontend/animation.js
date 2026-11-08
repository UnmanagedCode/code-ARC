// Viewer animation replay: the frames of the shown step, fetched on demand,
// played at the toolkit renderer's pace or stepped one by one. Pure (no DOM),
// driven by an injected clock so it is testable without real timers.
// A step shows its last frame until a control is used; rows() is then the
// frame at the position, or null for "draw the step's own frame".

// The toolkit renderer's default pace.
export const ANIMATION_FRAME_MS = 100;
// Steps whose frames are kept, per session.
const CACHE_MAX = 16;

// clock: { setTimeout(fn, ms): handle, clearTimeout(handle) }
// fetchFrames(n): Promise<{frame_count, stored, omitted, frames:[{index, rows}]}>
// onChange(): called after every change of what is shown.
export function createAnimation({ clock, fetchFrames, onChange }) {
  const cache = new Map();
  let step = null; // {n, frame_count} of the shown step
  let data = null; // the fetched frames of `step`, or null
  let pos = -1; // index into data.frames; -1 = the step's own last frame
  let playing = false;
  let played = false;
  let status = 'idle'; // idle | loading | ready | error
  let token = 0;
  let timer = null;

  const cancel = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const lastPos = () => (data ? data.frames.length - 1 : 0);

  // Fetches the shown step's frames once; resolves true when `data` is usable
  // for the step that was shown when it was asked.
  const inflight = new Map();
  function ensure() {
    if (data) return Promise.resolve(true);
    if (!step) return Promise.resolve(false);
    const key = `${token}:${step.n}`;
    if (!inflight.has(key)) inflight.set(key, load().finally(() => inflight.delete(key)));
    return inflight.get(key);
  }

  async function load() {
    const mine = token;
    const n = step.n;
    status = 'loading';
    onChange();
    try {
      const got = await fetchFrames(n);
      if (mine !== token) return false;
      if (!got || !Array.isArray(got.frames) || got.frames.length === 0) throw new Error('no frames');
      cache.set(n, got);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      data = got;
      status = 'ready';
      onChange();
      return true;
    } catch {
      if (mine !== token) return false;
      status = 'error';
      playing = false;
      onChange();
      return false;
    }
  }

  function tick() {
    timer = null;
    pos++;
    if (pos >= lastPos()) {
      pos = lastPos();
      playing = false;
    } else {
      timer = clock.setTimeout(tick, ANIMATION_FRAME_MS);
    }
    onChange();
  }

  return {
    get status() { return status; },
    get playing() { return playing; },
    get played() { return played; },
    // The hex rows to draw, or null for the step's own last frame.
    rows() { return data && pos >= 0 ? data.frames[pos].rows : null; },
    // Whether the animation controls apply to the shown step.
    get available() { return Boolean(step) && step.frame_count > 1; },
    // "frame i of N" by the toolkit's frame index; the last frame until a control moves it.
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

    reset() {
      token++;
      cancel();
      cache.clear();
      step = null;
      data = null;
      pos = -1;
      playing = false;
      played = false;
      status = 'idle';
      onChange();
    },

    // The step now shown. The same step keeps its state; a new one starts on its last frame.
    show(next) {
      if (next ? step && next.n === step.n : !step) return;
      token++;
      cancel();
      step = next ? { n: next.n, frame_count: next.frame_count } : null;
      data = step ? cache.get(step.n) || null : null;
      pos = -1;
      playing = false;
      played = false;
      status = data ? 'ready' : 'idle';
      onChange();
    },

    async play() {
      const mine = token;
      if (!(await ensure()) || mine !== token) return;
      cancel();
      pos = 0;
      playing = true;
      played = true;
      if (lastPos() === 0) playing = false;
      else timer = clock.setTimeout(tick, ANIMATION_FRAME_MS);
      onChange();
    },

    pause() {
      playing = false;
      cancel();
      onChange();
    },

    // One frame back (-1) or forward (+1), paused, clamped to the stored frames.
    async stepBy(delta) {
      const mine = token;
      playing = false;
      cancel();
      if (!(await ensure()) || mine !== token) return;
      const from = pos < 0 ? lastPos() : pos;
      pos = Math.max(0, Math.min(lastPos(), from + delta));
      onChange();
    },
  };
}
