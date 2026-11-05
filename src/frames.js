// Text renderings of a frame for the agent: one hex digit per cell (the
// palette index), a two-line x header (tens, units) and a `yy|` row label.
// Column x sits at index 3 + x on every line.
import { DIFF_MAX_ROWS } from './limits.js';

// Same width as the "yy|" row label. Visible, not blank: a layer that trims
// leading whitespace would otherwise shift the header against the rows.
const HEADER_LABEL = 'xx|';

function header(width) {
  let tens = HEADER_LABEL;
  let units = HEADER_LABEL;
  for (let x = 0; x < width; x++) {
    tens += String(Math.floor(x / 10) % 10);
    units += String(x % 10);
  }
  return `${tens}\n${units}`;
}

const row = (y, r) => `${String(y).padStart(2, '0')}|${r}`;

export function renderFull(rows) {
  return [header(rows[0].length), ...rows.map((r, y) => row(y, r))].join('\n');
}

// Changed rows only, compared with `prev` (the previous step's last frame;
// animation frames in between are not seen). Returns {text, changed_cells,
// bbox}; bbox is {x0, y0, x1, y1} inclusive over every changed cell, status-bar
// cells included, or null with no change.
export function renderDiff(prev, rows) {
  const lines = [];
  let changed = 0;
  let bbox = null;
  rows.forEach((r, y) => {
    const p = prev[y];
    if (p === r) return;
    lines.push(row(y, r));
    for (let x = 0; x < r.length; x++) {
      if (p[x] === r[x]) continue;
      changed++;
      if (!bbox) bbox = { x0: x, y0: y, x1: x, y1: y };
      else {
        bbox.x0 = Math.min(bbox.x0, x);
        bbox.x1 = Math.max(bbox.x1, x);
        bbox.y1 = y;
      }
    }
  });
  if (lines.length === 0) return { text: 'no cells changed', changed_cells: 0, bbox: null, rows: 0 };
  return { text: [header(rows[0].length), ...lines].join('\n'), changed_cells: changed, bbox, rows: lines.length };
}

const sameShape = (a, b) => Array.isArray(a) && a.length === b.length && a.every((r, i) => r.length === b[i].length);

// The text and meta.frame for a requested mode. `prev` is the frame before
// this observation (null when there is none). A diff with no comparable
// previous frame, or more than DIFF_MAX_ROWS changed rows, is sent full.
export function frameText(mode, prev, rows) {
  if (mode === 'none') return { text: '', frame: { mode: 'none' } };
  if (!rows) return { text: 'no frame', frame: { mode } };
  if (mode === 'diff') {
    if (sameShape(prev, rows)) {
      const d = renderDiff(prev, rows);
      if (d.rows <= DIFF_MAX_ROWS) return { text: d.text, frame: { mode: 'diff', changed_cells: d.changed_cells, bbox: d.bbox } };
    }
    return { text: renderFull(rows), frame: { mode: 'full', auto_full: true } };
  }
  return { text: renderFull(rows), frame: { mode: 'full' } };
}
