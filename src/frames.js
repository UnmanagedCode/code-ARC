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

// The rows that differ from `prev` (the previous step's last frame; animation
// frames in between are not seen): {changed_rows:[{y, row}], changed_cells,
// bbox}. bbox is {x0, y0, x1, y1} inclusive over every changed cell, status-bar
// cells included, or null with no change. The one change computation behind
// both the text and the json views.
export function diffRows(prev, rows) {
  const changedRows = [];
  let changed = 0;
  let bbox = null;
  rows.forEach((r, y) => {
    const p = prev[y];
    if (p === r) return;
    changedRows.push({ y, row: r });
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
  return { changed_rows: changedRows, changed_cells: changed, bbox };
}

// Changed rows only, as labelled text. Returns {text, changed_cells, bbox, rows}.
export function renderDiff(prev, rows) {
  const d = diffRows(prev, rows);
  if (d.changed_rows.length === 0) return { text: 'no cells changed', changed_cells: 0, bbox: null, rows: 0 };
  const lines = d.changed_rows.map(({ y, row: r }) => row(y, r));
  return { text: [header(rows[0].length), ...lines].join('\n'), changed_cells: d.changed_cells, bbox: d.bbox, rows: lines.length };
}

const sameShape = (a, b) => Array.isArray(a) && a.length === b.length && a.every((r, i) => r.length === b[i].length);

// The text view's text and frame descriptor for a requested mode. `prev` is the frame before
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

// The json view's frame for a requested mode: complete data, never switched to
// full for size. `rows` is the hex row strings. A diff with no comparable
// previous frame is full with auto_full; no current frame is full with null rows.
export function frameData(mode, prev, rows) {
  if (mode === 'none') return { mode: 'none' };
  if (!rows) return { mode: 'full', rows: null, ...(mode === 'diff' ? { auto_full: true } : {}) };
  if (mode === 'diff') {
    if (!sameShape(prev, rows)) return { mode: 'full', auto_full: true, rows };
    const d = diffRows(prev, rows);
    return { mode: 'diff', changed_cells: d.changed_cells, bbox: d.bbox, changed_rows: d.changed_rows };
  }
  return { mode: 'full', rows };
}
