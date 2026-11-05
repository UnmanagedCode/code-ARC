import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameText, renderDiff, renderFull } from '../src/frames.js';
import { DIFF_MAX_ROWS } from '../src/limits.js';

const blank = (w = 64, h = 64, c = '5') => Array.from({ length: h }, () => c.repeat(w));
const set = (rows, x, y, v) => rows.map((r, i) => (i === y ? r.slice(0, x) + v + r.slice(x + 1) : r));

test('full frame: x header (tens, units) and yy| row labels', () => {
  const lines = renderFull(blank()).split('\n');
  assert.equal(lines.length, 66);
  assert.equal(lines[0], `   ${'0'.repeat(10)}${'1'.repeat(10)}${'2'.repeat(10)}${'3'.repeat(10)}${'4'.repeat(10)}${'5'.repeat(10)}6666`);
  assert.equal(lines[1], `   ${'0123456789'.repeat(6)}0123`);
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
