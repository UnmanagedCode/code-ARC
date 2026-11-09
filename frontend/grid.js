// Draws a frame (rows of hex digits) onto a canvas, one pixel per cell,
// scaled up by CSS; hovering shows the cell's coordinates and value.
import { RGBA } from './palette.js';

// The cell under a point of a w×h grid stretched over `rect` (the canvas's
// bounding box), clamped to the grid.
export function cellAt(rect, clientX, clientY, w, h) {
  const x = Math.min(w - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * w)));
  const y = Math.min(h - 1, Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * h)));
  return { x, y };
}

// `onCell({x, y})` runs when a drawn frame is clicked.
export function createGrid(canvas, hoverEl, { onCell } = {}) {
  const ctx = canvas.getContext('2d');
  let rows = null;

  function draw(next) {
    rows = next && next.length ? next : null;
    if (!rows) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.dataset.drawn = 'false';
      return;
    }
    const h = rows.length;
    const w = rows[0].length;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const row = rows[y];
      for (let x = 0; x < w; x++) {
        const c = RGBA[parseInt(row[x], 16)] || [0, 0, 0, 0];
        const o = (y * w + x) * 4;
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = c[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    canvas.dataset.drawn = 'true';
  }

  canvas.addEventListener('mousemove', (e) => {
    if (!rows) return;
    const { x, y } = cellAt(canvas.getBoundingClientRect(), e.clientX, e.clientY, rows[0].length, rows.length);
    hoverEl.textContent = `x,y = ${x},${y}  value = ${parseInt(rows[y][x], 16)}`;
  });
  canvas.addEventListener('click', (e) => {
    if (!rows || !onCell) return;
    onCell(cellAt(canvas.getBoundingClientRect(), e.clientX, e.clientY, rows[0].length, rows.length));
  });
  canvas.addEventListener('mouseleave', () => { hoverEl.textContent = ' '; });

  return { draw };
}
