// The animation of one step, for act, observe and the viewer's frames route.
// Pure functions over {anim, frame, frame_count}: `anim` holds the stored
// frames before the last (absent for a step stored without them), `frame` the
// last, `frame_count` the toolkit's true count.
// Frame indexes are the toolkit's: leading frames are 0..k-1 and the last is
// frame_count - 1, so a gap shows as a jump in `index`.
import { ANIMATION_FRAMES_MAX, ANIMATION_PAGE_MAX } from './limits.js';
import { frameData, frameText } from './frames.js';

// {frames:[{index, rows}], stored, omitted}; no frame (a terminal step) gives none.
export function stepFrames({ anim, frame, frame_count: count }) {
  if (!frame) return { frames: [], stored: 0, omitted: Math.max(0, count) };
  const lead = Array.isArray(anim) ? anim : [];
  const frames = [...lead.map((rows, index) => ({ index, rows })), { index: Math.max(count - 1, lead.length), rows: frame }];
  return { frames, stored: frames.length, omitted: Math.max(0, count - frames.length) };
}

// The page of stored frames with index >= from: at most ANIMATION_PAGE_MAX,
// plus `next_from` (index of the next stored frame, or null) and `truncated`.
export function animationPage(seq, from = 0) {
  const rest = seq.frames.filter((f) => f.index >= from);
  const frames = rest.slice(0, ANIMATION_PAGE_MAX);
  const next = rest[ANIMATION_PAGE_MAX];
  return { frames, next_from: next ? next.index : null, truncated: Boolean(next) };
}

function summary({ step, frame_count: count }, seq, page, from) {
  return { step, frame_count: count, stored: seq.stored, omitted: seq.omitted, from, next_from: page.next_from, truncated: page.truncated };
}

// {meta, frames}: the json view's entry without its frames, and the page's
// frames ({index, rows}).
export function animationView(src, from = 0) {
  const seq = stepFrames(src);
  const page = animationPage(seq, from);
  return { meta: summary(src, seq, page, from), frames: page.frames };
}

// The json view: the first frame of the page full, each later one a diff
// against the frame before it.
export function animationData(src, { from = 0 } = {}) {
  const { meta, frames } = animationView(src, from);
  return { ...meta, frames: frames.map((f, i) => ({ index: f.index, ...(i === 0 ? frameData('full', null, f.rows) : frameData('diff', frames[i - 1].rows, f.rows)) })) };
}

const range = (a, b) => (a === b ? `${a}` : `${a}-${b}`);

// The gap and paging notices of a summary (animationView's `meta`).
export function animationNotes(m) {
  const lines = [];
  if (m.omitted > 0) {
    lines.push(m.stored === 1
      ? `Earlier frames were not recorded (${m.omitted} of ${m.frame_count} missing).`
      : `Frames ${range(m.stored - 1, m.frame_count - 2)} were not stored (actions over ${ANIMATION_FRAMES_MAX} frames keep the first ${ANIMATION_FRAMES_MAX - 1} and the last).`);
  }
  if (m.truncated) lines.push(`truncated: at most ${ANIMATION_PAGE_MAX} frames per call; for the rest call observe with animation:"all", animation_step:${m.step}, animation_from:${m.next_from}.`);
  return lines;
}

// The text view's section: header, labelled frames, gap and paging notices.
export function animationText(src, { from = 0 } = {}) {
  const { meta: m, frames } = animationView(src, from);
  const shown = frames.length ? `frames ${range(frames[0].index, frames.at(-1).index)}` : 'no frames';
  const lines = [`Animation of step ${m.step}: frame_count ${m.frame_count}, ${m.stored} stored, showing ${shown} (first full, the rest diffs against the frame before).`];
  frames.forEach((f, i) => {
    const ft = i === 0 ? frameText('full', null, f.rows) : frameText('diff', frames[i - 1].rows, f.rows);
    const label = ft.frame.mode === 'full' ? `full${ft.frame.auto_full ? ', auto_full' : ''}` : `diff, ${ft.frame.changed_cells} cells changed`;
    lines.push(`frame ${f.index} (${label}):`, ft.text);
  });
  lines.push(...animationNotes(m));
  return lines.join('\n');
}
