// Draws a frame (rows of hex digits) onto a canvas, one pixel per cell,
// scaled up by CSS; hovering shows the cell's coordinates and value.
import { RGBA } from './palette.js';

export function createGrid(canvas, hoverEl) {
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
    const r = canvas.getBoundingClientRect();
    const x = Math.min(rows[0].length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * rows[0].length)));
    const y = Math.min(rows.length - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * rows.length)));
    hoverEl.textContent = `x,y = ${x},${y}  value = ${parseInt(rows[y][x], 16)}`;
  });
  canvas.addEventListener('mouseleave', () => { hoverEl.textContent = ' '; });

  return { draw };
}
