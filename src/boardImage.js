// Renders a frame (hex rows) to a board image: the pixel rules are
// docs/protocol.md → Board image, every number and colour comes from
// clients/board_image.json. clients/code_arc.py (Observation.save_png) renders
// the same rules; tests/boardImage.test.mjs pins the two to identical pixels.
import IMAGE_SPEC from '../clients/board_image.json' with { type: 'json' };
import { COORD_MAX } from './limits.js';
import { encodePng } from './png.js';

export { IMAGE_SPEC };

const FRAME_SIDE = COORD_MAX + 1;
const HEX_ROW = /^[0-9a-fA-F]+$/;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const DIGITS = '0123456789';

function fail(msg) {
  throw new Error(`clients/board_image.json: ${msg}`);
}

function colour(hex, where) {
  if (typeof hex !== 'string' || !COLOUR.test(hex)) fail(`${where} must be "#RRGGBB"`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function int(v, min, where) {
  if (!Number.isInteger(v) || v < min) fail(`${where} must be an integer >= ${min}`);
  return v;
}

// The spec with colours parsed; throws on a malformed spec.
function compile(spec) {
  const { palette, scale, grid: g } = spec;
  if (!Array.isArray(palette) || palette.length !== 16) fail('palette must list 16 colours');
  if (!Array.isArray(g?.contrast) || g.contrast.length !== 16) fail('grid.contrast must list 16 colours');
  int(scale?.min, 1, 'scale.min');
  if (int(scale.max, scale.min, 'scale.max') < int(scale.default, scale.min, 'scale.default')) fail('scale.default must be <= scale.max');
  if (typeof g.default !== 'boolean') fail('grid.default must be a boolean');
  const glyphs = {};
  let glyphWidth = null;
  for (const d of DIGITS) {
    const rows = g.glyphs?.[d];
    if (!Array.isArray(rows) || rows.length === 0 || !rows.every((r) => typeof r === 'string' && /^[#.]+$/.test(r) && r.length === rows[0].length)) fail(`grid.glyphs["${d}"] must be equal-length rows of "#" and "."`);
    glyphWidth ??= rows[0].length;
    if (rows[0].length !== glyphWidth) fail('every glyph must have the same width');
    glyphs[d] = rows;
  }
  return {
    palette: palette.map((h, i) => colour(h, `palette[${i}]`)),
    contrast: g.contrast.map((h, i) => colour(h, `grid.contrast[${i}]`)),
    marginRgb: colour(g.margin_rgb, 'grid.margin_rgb'),
    labelRgb: colour(g.label_rgb, 'grid.label_rgb'),
    every: int(g.every, 1, 'grid.every'),
    margin: int(g.margin, 0, 'grid.margin'),
    tickLen: int(g.tick_len, 0, 'grid.tick_len'),
    dash: int(g.dash, 1, 'grid.dash'),
    fontScale: int(g.font_scale, 1, 'grid.font_scale'),
    labelOffset: int(g.label_offset, 0, 'grid.label_offset'),
    glyphs,
    glyphAdvance: glyphWidth + 1,
  };
}

const S = compile(IMAGE_SPEC);

// Palette indexes, row-major; throws on a frame outside the rules.
function digitsOf(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > FRAME_SIDE) throw new Error(`a board image needs 1-${FRAME_SIDE} rows`);
  const W = typeof rows[0] === 'string' ? rows[0].length : 0;
  if (W < 1 || W > FRAME_SIDE) throw new Error(`a board image needs a width of 1-${FRAME_SIDE}`);
  const out = new Uint8Array(rows.length * W);
  rows.forEach((r, y) => {
    if (typeof r !== 'string' || r.length !== W) throw new Error(`ragged rows: row ${y} is not ${W} wide`);
    if (!HEX_ROW.test(r)) throw new Error(`row ${y} has a non-hex digit`);
    for (let x = 0; x < W; x++) out[y * W + x] = parseInt(r[x], 16);
  });
  return { digits: out, H: rows.length, W };
}

// {width, height, rgb} (rgb row-major, 3 bytes a pixel).
export function renderBoard(rows, { scale, grid }) {
  const { min, max } = IMAGE_SPEC.scale;
  if (!Number.isInteger(scale) || scale < min || scale > max) throw new Error(`scale must be an integer in ${min}-${max}`);
  if (typeof grid !== 'boolean') throw new Error('grid must be a boolean');
  const { digits, H, W } = digitsOf(rows);
  const s = scale;
  const M = grid ? S.margin : 0;
  const width = M + W * s;
  const height = M + H * s;
  const rgb = Buffer.alloc(width * height * 3);
  const set = (x, y, c) => {
    const i = (y * width + x) * 3;
    rgb[i] = c[0];
    rgb[i + 1] = c[1];
    rgb[i + 2] = c[2];
  };
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < width && y < height) set(x, y, c); };

  // Margin and board: one pixel row per cell row, copied `s` times.
  const marginRow = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x++) marginRow.set(S.marginRgb, x * 3);
  for (let y = 0; y < M; y++) marginRow.copy(rgb, y * width * 3);
  const line = Buffer.alloc(width * 3);
  marginRow.copy(line);
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const c = S.palette[digits[cy * W + cx]];
      for (let k = 0; k < s; k++) line.set(c, (M + cx * s + k) * 3);
    }
    for (let k = 0; k < s; k++) line.copy(rgb, (M + cy * s + k) * width * 3);
  }
  if (!grid) return { width, height, rgb };

  // Dashed lines in the contrast colour of the cell under each drawn pixel.
  for (let c = S.every; c < W; c += S.every) {
    for (let along = 0; along < H * s; along += 1) {
      if (Math.floor(along / S.dash) % 2 === 0) set(M + c * s, M + along, S.contrast[digits[Math.floor(along / s) * W + c]]);
    }
  }
  for (let r = S.every; r < H; r += S.every) {
    for (let along = 0; along < W * s; along += 1) {
      if (Math.floor(along / S.dash) % 2 === 0) set(M + along, M + r * s, S.contrast[digits[r * W + Math.floor(along / s)]]);
    }
  }

  // Ticks and decimal labels in the margins, clipped to the image.
  const label = (n, ox, oy) => {
    [...String(n)].forEach((d, i) => {
      const dx = ox + i * S.glyphAdvance * S.fontScale;
      S.glyphs[d].forEach((glyphRow, gy) => {
        for (let gx = 0; gx < glyphRow.length; gx++) {
          if (glyphRow[gx] !== '#') continue;
          for (let a = 0; a < S.fontScale; a++) {
            for (let b = 0; b < S.fontScale; b++) put(dx + gx * S.fontScale + a, oy + gy * S.fontScale + b, S.labelRgb);
          }
        }
      });
    });
  };
  for (let c = 0; c < W; c += S.every) {
    for (let y = M - S.tickLen; y < M; y++) put(M + c * s, y, S.labelRgb);
    label(c, M + c * s + S.labelOffset, S.labelOffset);
  }
  for (let r = 0; r < H; r += S.every) {
    for (let x = M - S.tickLen; x < M; x++) put(x, M + r * s, S.labelRgb);
    label(r, S.labelOffset, M + r * s + S.labelOffset);
  }
  return { width, height, rgb };
}

export function boardPng(rows, opts) {
  const { width, height, rgb } = renderBoard(rows, opts);
  return encodePng(width, height, rgb);
}
