// The ARC-AGI-3 palette: arc_agi.rendering.COLOR_MAP, verbatim (#RRGGBBAA).
// sidecar/tests/test_real_toolkit.py checks it against the installed toolkit.
export const COLOR_MAP = {
  0: '#FFFFFFFF',
  1: '#CCCCCCFF',
  2: '#999999FF',
  3: '#666666FF',
  4: '#333333FF',
  5: '#000000FF',
  6: '#E53AA3FF',
  7: '#FF7BCCFF',
  8: '#F93C31FF',
  9: '#1E93FFFF',
  10: '#88D8F1FF',
  11: '#FFDC00FF',
  12: '#FF851BFF',
  13: '#921231FF',
  14: '#4FCC30FF',
  15: '#A356D6FF',
};

// [r, g, b, a] per palette index.
export const RGBA = Object.fromEntries(Object.entries(COLOR_MAP).map(([k, hex]) => [
  k, [1, 3, 5, 7].map((i) => parseInt(hex.slice(i, i + 2), 16)),
]));
