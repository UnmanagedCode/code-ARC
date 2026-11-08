// The board image renderer (src/boardImage.js), its PNG encoder (src/png.js)
// The pixel rules are docs/protocol.md → Board image; the numbers come from IMAGE_SPEC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, rgbOf } from './_png.mjs';
import { encodePng } from '../src/png.js';
import { boardPng, IMAGE_SPEC, renderBoard, renderSheet, sheetPng } from '../src/boardImage.js';
import { COLOR_MAP } from '../frontend/palette.js';

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const PALETTE = IMAGE_SPEC.palette.map(hexRgb);
const CONTRAST = IMAGE_SPEC.grid.contrast.map(hexRgb);
const MARGIN_RGB = hexRgb(IMAGE_SPEC.grid.margin_rgb);
const LABEL_RGB = hexRgb(IMAGE_SPEC.grid.label_rgb);
const { min: SMIN, max: SMAX, default: SDEF } = IMAGE_SPEC.scale;
const SCALES = [SMIN, SDEF, SMAX];

// H rows of W hex digits; every digit appears once H*W >= 16, and horizontal
// and vertical neighbours differ.
const frame = (h, w) => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => ((x * 7 + y * 3) % 16).toString(16)).join(''));
const BIG = frame(64, 64);
const ODD = frame(7, 13);

const pxOf = (img, x, y) => {
  const i = (y * img.width + x) * 3;
  return [img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]];
};

// The label_rgb pixel set the rules give for the margins (ticks and digits),
// as "x,y" keys; with `clip: false`, also the pixels that fall outside the image.
function labelPixels(rows, s, { clip = true } = {}) {
  const g = IMAGE_SPEC.grid;
  const H = rows.length;
  const W = rows[0].length;
  const M = g.margin;
  const width = M + W * s;
  const height = M + H * s;
  const set = new Set();
  const put = (x, y) => { if (!clip || (x >= 0 && y >= 0 && x < width && y < height)) set.add(`${x},${y}`); };
  const label = (n, ox, oy) => [...String(n)].forEach((d, i) => {
    const glyph = g.glyphs[d];
    const dx = ox + i * (glyph[0].length + 1) * g.font_scale;
    glyph.forEach((line, gy) => [...line].forEach((ch, gx) => {
      if (ch !== '#') return;
      for (let a = 0; a < g.font_scale; a++) for (let b = 0; b < g.font_scale; b++) put(dx + gx * g.font_scale + a, oy + gy * g.font_scale + b);
    }));
  });
  for (let c = 0; c < W; c += g.every) {
    for (let y = M - g.tick_len; y < M; y++) put(M + c * s, y);
    label(c, M + c * s + g.label_offset, g.label_offset);
  }
  for (let r = 0; r < H; r += g.every) {
    for (let x = M - g.tick_len; x < M; x++) put(x, M + r * s);
    label(r, g.label_offset, M + r * s + g.label_offset);
  }
  return set;
}

test('encoder round-trips: pixels, IHDR fields and every CRC', () => {
  const w = 5;
  const h = 3;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set([i * 17, 255 - i * 13, (i * 101) % 256], i * 3);
  const img = decodePng(encodePng(w, h, rgb)); // throws on a bad CRC or IHDR
  assert.deepEqual([img.width, img.height], [w, h]);
  assert.deepEqual(rgbOf(img), rgb);
  assert.deepEqual(img.chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
});

test('board pixels are palette-correct at every scale (grid off)', () => {
  for (const s of SCALES) {
    const img = renderBoard(BIG, { scale: s, grid: false });
    assert.deepEqual([img.width, img.height], [64 * s, 64 * s], `scale ${s}`);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const want = PALETTE[parseInt(BIG[Math.floor(y / s)][Math.floor(x / s)], 16)];
        const got = pxOf(img, x, y);
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) assert.fail(`scale ${s}: pixel ${x},${y} is ${got}, want ${want}`);
      }
    }
  }
});

test('grid layout: blocks, dashed contrast lines, ticks and labels in the margin', () => {
  const g = IMAGE_SPEC.grid;
  const M = g.margin;
  for (const rows of [BIG, ODD]) {
    for (const s of SCALES) {
      const H = rows.length;
      const W = rows[0].length;
      const img = renderBoard(rows, { scale: s, grid: true });
      assert.deepEqual([img.width, img.height], [M + W * s, M + H * s]);
      const labels = labelPixels(rows, s);
      let lineDrawn = 0;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const got = pxOf(img, x, y);
          let want;
          if (x < M || y < M) {
            want = labels.has(`${x},${y}`) ? LABEL_RGB : MARGIN_RGB;
          } else {
            const cx = Math.floor((x - M) / s);
            const cy = Math.floor((y - M) / s);
            const digit = parseInt(rows[cy][cx], 16);
            const vLine = (x - M) % s === 0 && cx > 0 && cx % g.every === 0;
            const hLine = (y - M) % s === 0 && cy > 0 && cy % g.every === 0;
            const onV = vLine && Math.floor((y - M) / g.dash) % 2 === 0;
            const onH = hLine && Math.floor((x - M) / g.dash) % 2 === 0;
            want = onV || onH ? CONTRAST[digit] : PALETTE[digit];
            if (onV || onH) lineDrawn++;
          }
          if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) assert.fail(`${H}x${W} scale ${s}: pixel ${x},${y} is ${got}, want ${want}`);
        }
      }
      assert.ok(lineDrawn > 0, 'some line pixels are drawn');
      assert.ok(labels.size > 0, 'some label pixels are drawn');
    }
  }
});

test('labels past the image edge are clipped: drawn inside, nowhere else', () => {
  // A 1x1 board at the smallest scale: the "0" labels run past the right and
  // bottom edges.
  const rows = ['3'];
  const s = SMIN;
  const M = IMAGE_SPEC.grid.margin;
  const img = renderBoard(rows, { scale: s, grid: true });
  assert.deepEqual([img.width, img.height], [M + s, M + s]);
  const inside = labelPixels(rows, s);
  const all = labelPixels(rows, s, { clip: false });
  assert.ok(all.size > inside.size, 'the case clips some label pixels');
  const off = IMAGE_SPEC.grid.label_offset;
  assert.ok(inside.has(`${M + off},${off}`), 'and keeps the in-image part of the clipped top "0"');
  // Every pixel: the in-image label pixels are label_rgb; everything else in
  // the margin is margin_rgb (no clipped pixel wraps onto another row), and
  // the board is its cell's colour.
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const want = x >= M && y >= M ? PALETTE[3] : inside.has(`${x},${y}`) ? LABEL_RGB : MARGIN_RGB;
      assert.deepEqual(pxOf(img, x, y), want, `pixel ${x},${y}`);
    }
  }
});

test('grid.contrast follows the documented luminance rule over the palette', () => {
  const rule = PALETTE.map(([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b >= 128 ? [0, 0, 0] : [255, 255, 255]));
  assert.deepEqual(CONTRAST, rule);
});

test('the spec palette is the viewer palette', () => {
  assert.equal(IMAGE_SPEC.palette.length, 16);
  for (let i = 0; i < 16; i++) assert.equal(`${IMAGE_SPEC.palette[i]}FF`, COLOR_MAP[i], `index ${i}`);
});

test('bad input fails loudly', () => {
  const opts = { scale: SDEF, grid: true };
  assert.throws(() => renderBoard(['012', '01'], opts), /ragged|width/);
  assert.throws(() => renderBoard(['01g'], opts), /hex/);
  assert.throws(() => renderBoard(frame(65, 4), opts), /1-64|rows/);
  assert.throws(() => renderBoard([], opts), /1-64|rows/);
  assert.throws(() => renderBoard(['0'.repeat(65)], opts), /1-64|width/);
  assert.throws(() => renderBoard(['0'], { scale: SMIN - 1, grid: true }), /scale/);
  assert.throws(() => renderBoard(['0'], { scale: SMAX + 1, grid: true }), /scale/);
  assert.throws(() => renderBoard(['0'], { scale: 4.5, grid: true }), /scale/);
  assert.throws(() => renderBoard(['0'], { scale: SDEF, grid: 'yes' }), /grid/);
});

test('boardPng decodes to renderBoard', () => {
  const opts = { scale: SMIN, grid: true };
  const img = decodePng(boardPng(ODD, opts));
  const want = renderBoard(ODD, opts);
  assert.deepEqual([img.width, img.height], [want.width, want.height]);
  assert.deepEqual(rgbOf(img), want.rgb);
});

// --- contact sheet (renderSheet) -------------------------------------------

const SHEET = IMAGE_SPEC.sheet;
const tiles = (n, rows = ODD) => Array.from({ length: n }, (_, i) => ({ index: i * 3, rows: rows.map((r) => r.replace(/./g, (c) => ((parseInt(c, 16) + i) % 16).toString(16))) }));
const SHEET_OPTS = { scale: SHEET.scale_default, grid: true };

test('sheet size: tiles in rows of sheet.columns with sheet.gap around and between them', () => {
  const tile = renderBoard(ODD, SHEET_OPTS);
  const strip = IMAGE_SPEC.grid.glyphs['0'].length * IMAGE_SPEC.grid.font_scale + 2 * IMAGE_SPEC.grid.label_offset;
  for (const [n, cols, rowsN] of [[1, 1, 1], [4, 4, 1], [5, 4, 2], [16, 4, 4]]) {
    const img = renderSheet(tiles(n), SHEET_OPTS);
    assert.equal(img.width, SHEET.gap + cols * (tile.width + SHEET.gap), `${n} tiles wide`);
    assert.equal(img.height, SHEET.gap + rowsN * (strip + tile.height + SHEET.gap), `${n} tiles high`);
    assert.equal(img.rgb.length, img.width * img.height * 3);
  }
});

test('each sheet tile region equals the board render at its offset', () => {
  const ts = tiles(5);
  const img = renderSheet(ts, SHEET_OPTS);
  const strip = IMAGE_SPEC.grid.glyphs['0'].length * IMAGE_SPEC.grid.font_scale + 2 * IMAGE_SPEC.grid.label_offset;
  ts.forEach((t, i) => {
    const board = renderBoard(t.rows, SHEET_OPTS);
    const ox = SHEET.gap + (i % SHEET.columns) * (board.width + SHEET.gap);
    const oy = SHEET.gap + Math.floor(i / SHEET.columns) * (strip + board.height + SHEET.gap) + strip;
    for (let y = 0; y < board.height; y++) {
      const from = (y * board.width) * 3;
      const at = ((oy + y) * img.width + ox) * 3;
      assert.ok(board.rgb.subarray(from, from + board.width * 3).equals(img.rgb.subarray(at, at + board.width * 3)), `tile ${i} row ${y}`);
    }
  });
});

test('sheet tiles are labelled: the strip above a tile holds label pixels, the gap holds none', () => {
  const img = renderSheet(tiles(2), SHEET_OPTS);
  const count = (x0, y0, x1, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pxOf(img, x, y).join() === LABEL_RGB.join()) n++;
    return n;
  };
  assert.ok(count(SHEET.gap, SHEET.gap, SHEET.gap + 30, SHEET.gap + 10) > 0, 'the first tile has a label');
  assert.equal(count(0, 0, img.width, SHEET.gap), 0, 'the top gap is clear');
});

test('sheets of mixed tile shapes sit top-left in cells of the largest tile; the PNG decodes to the same size', () => {
  const img = renderSheet([{ index: 0, rows: ['00', '00'] }, { index: 1, rows: ODD }], SHEET_OPTS);
  const big = renderBoard(ODD, SHEET_OPTS);
  assert.equal(img.width, SHEET.gap + 2 * (big.width + SHEET.gap));
  const png = decodePng(sheetPng(tiles(3), SHEET_OPTS));
  assert.equal(png.width, renderSheet(tiles(3), SHEET_OPTS).width);
});

test('a sheet needs at least one frame', () => {
  assert.throws(() => renderSheet([], SHEET_OPTS), /at least one frame/);
});
