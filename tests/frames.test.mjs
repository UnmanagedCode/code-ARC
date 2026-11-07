import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameData, frameText, renderDiff, renderFull } from '../src/frames.js';
import { DIFF_MAX_ROWS } from '../src/limits.js';

const blank = (w = 64, h = 64, c = '5') => Array.from({ length: h }, () => c.repeat(w));
const set = (rows, x, y, v) => rows.map((r, i) => (i === y ? r.slice(0, x) + v + r.slice(x + 1) : r));

test('full frame: x header (tens, units) and yy| row labels', () => {
  const lines = renderFull(blank()).split('\n');
  assert.equal(lines.length, 66);
  assert.equal(lines[0], `xx|${'0'.repeat(10)}${'1'.repeat(10)}${'2'.repeat(10)}${'3'.repeat(10)}${'4'.repeat(10)}${'5'.repeat(10)}6666`);
  assert.equal(lines[1], `xx|${'0123456789'.repeat(6)}0123`);
  assert.equal(lines[2], `00|${'5'.repeat(64)}`);
  assert.equal(lines[65], `63|${'5'.repeat(64)}`);
});

test('full frame column under header digit is the cell at that x', () => {
  const rows = set(blank(), 37, 9, 'f');
  const lines = renderFull(rows).split('\n');
  const col = lines[0].length - 64 + 37;
  assert.equal(lines[0][col] + lines[1][col], '37');
  assert.equal(lines[2 + 9][col], 'f');
});

test('diff lists only changed rows, with count and bbox', () => {
  const prev = blank();
  const next = set(set(prev, 3, 2, '9'), 10, 7, '8');
  const d = renderDiff(prev, next);
  assert.equal(d.changed_cells, 2);
  assert.deepEqual(d.bbox, { x0: 3, y0: 2, x1: 10, y1: 7 });
  const lines = d.text.split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[2].startsWith('02|'));
  assert.ok(lines[3].startsWith('07|'));
});

test('no change reads "no cells changed"', () => {
  const r = frameText('diff', blank(), blank());
  assert.equal(r.text, 'no cells changed');
  assert.deepEqual(r.frame, { mode: 'diff', changed_cells: 0, bbox: null });
});

test(`a diff over ${DIFF_MAX_ROWS} rows is sent full with auto_full`, () => {
  const prev = blank();
  let next = prev;
  for (let y = 0; y <= DIFF_MAX_ROWS; y++) next = set(next, 0, y, 'a');
  const r = frameText('diff', prev, next);
  assert.deepEqual(r.frame, { mode: 'full', auto_full: true });
  assert.equal(r.text.split('\n').length, 66);
  let at = prev;
  for (let y = 0; y < DIFF_MAX_ROWS; y++) at = set(at, 0, y, 'a');
  assert.equal(frameText('diff', prev, at).frame.mode, 'diff');
});

test('diff without a previous frame is sent full; none is empty', () => {
  assert.deepEqual(frameText('diff', null, blank()).frame, { mode: 'full', auto_full: true });
  assert.deepEqual(frameText('none', null, blank()), { text: '', frame: { mode: 'none' } });
  assert.equal(frameText('full', null, null).text, 'no frame');
});

test('no frame-text line starts with whitespace, full or diff', () => {
  const prev = blank();
  const next = set(prev, 5, 5, 'a');
  for (const text of [renderFull(next), renderDiff(prev, next).text]) {
    for (const line of text.split('\n')) assert.doesNotMatch(line, /^\s/, line);
  }
});

test('cell x sits at index 3 + x on every row, under its digits on both header lines', () => {
  let rows = blank();
  for (const [x, y] of [[0, 0], [9, 1], [10, 2], [37, 9], [63, 63]]) rows = set(rows, x, y, 'f');
  const lines = renderFull(rows).split('\n');
  for (const [x, y] of [[0, 0], [9, 1], [10, 2], [37, 9], [63, 63]]) {
    assert.equal(lines[0][3 + x] + lines[1][3 + x], String(x).padStart(2, '0'));
    assert.equal(lines[2 + y][3 + x], 'f');
  }
  const diff = renderDiff(blank(), rows).text.split('\n');
  assert.equal(diff[0][3 + 37] + diff[1][3 + 37], '37');
  assert.equal(diff.find((l) => l.startsWith('09|'))[3 + 37], 'f');
});

test('changed_cells equals a positional count of differing cells', () => {
  const prev = blank();
  let next = prev;
  const cells = [[0, 0], [1, 0], [63, 0], [20, 30], [21, 30], [5, 63]];
  for (const [x, y] of cells) next = set(next, x, y, 'c');
  let count = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (prev[y][x] !== next[y][x]) count++;
  assert.equal(count, cells.length);
  assert.equal(renderDiff(prev, next).changed_cells, count);
});

test('bbox spans to a changed status-bar cell at (63,63)', () => {
  const prev = blank();
  const next = set(set(prev, 10, 12, '9'), 63, 63, '1');
  assert.deepEqual(renderDiff(prev, next).bbox, { x0: 10, y0: 12, x1: 63, y1: 63 });
});

// Invariant: the json view's diff is complete. The row-count switch to a full
// frame is a text-view heuristic only (frameData has none).
test('frameData diff lists every changed row past DIFF_MAX_ROWS; frameText switches to full', () => {
  const prev = blank();
  const next = blank();
  const n = DIFF_MAX_ROWS + 5;
  for (let y = 0; y < n; y++) next[y] = next[y].slice(0, 5) + 'f' + next[y].slice(6);
  const d = frameData('diff', prev, next);
  assert.equal(d.mode, 'diff');
  assert.equal(d.changed_rows.length, n);
  assert.equal(d.changed_cells, n);
  for (const [i, r] of d.changed_rows.entries()) assert.deepEqual(r, { y: i, row: next[i] });
  assert.deepEqual(d.bbox, { x0: 5, y0: 0, x1: 5, y1: n - 1 });
  assert.deepEqual(frameText('diff', prev, next).frame, { mode: 'full', auto_full: true });
});

// Invariant: changed_rows are exactly the rows that differ, in order, with the
// same counts renderDiff reports.
test('frameData diff rows are the differing rows and agree with renderDiff', () => {
  const prev = blank();
  const next = blank();
  next[3] = 'f' + next[3].slice(1);
  next[9] = next[9].slice(0, 63) + 'a';
  const d = frameData('diff', prev, next);
  assert.deepEqual(d.changed_rows.map((r) => r.y), [3, 9]);
  const t = renderDiff(prev, next);
  assert.equal(d.changed_cells, t.changed_cells);
  assert.deepEqual(d.bbox, t.bbox);
  assert.deepEqual(frameData('diff', prev, prev), { mode: 'diff', changed_cells: 0, bbox: null, changed_rows: [] });
});

// Invariant: each non-diff mode and each missing input yields the documented json frame.
test('frameData full, none, no previous frame and no current frame', () => {
  const rows = blank();
  assert.deepEqual(frameData('full', null, rows), { mode: 'full', rows });
  assert.deepEqual(frameData('none', null, rows), { mode: 'none' });
  assert.deepEqual(frameData('diff', null, rows), { mode: 'full', auto_full: true, rows });
  assert.deepEqual(frameData('diff', rows.slice(1), rows), { mode: 'full', auto_full: true, rows });
  assert.deepEqual(frameData('full', null, null), { mode: 'full', rows: null });
  assert.deepEqual(frameData('diff', rows, null), { mode: 'full', rows: null, auto_full: true });
});
