// Test-only PNG decoder, written independently of src/png.js: checks every
// chunk CRC with node:zlib's crc32 and accepts only what the board image spec
// emits (8-bit truecolour RGB, no interlace, filter byte 0 on every row).
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// {width, height, chunks, px(x, y) -> [r, g, b]}. Throws on anything else.
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG signature');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (zlib.crc32(buf.subarray(off + 4, off + 8 + len)) !== crc) throw new Error(`bad CRC in ${type}`);
    chunks.push({ type, data });
    off += 12 + len;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks.at(-1)?.type !== 'IEND') throw new Error('IHDR first and IEND last required');
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colourType, compression, filter, interlace] = ihdr.subarray(8, 13);
  if (depth !== 8 || colourType !== 2 || compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error(`unsupported IHDR: depth ${depth} type ${colourType} interlace ${interlace}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = 1 + width * 3;
  if (raw.length !== stride * height) throw new Error(`IDAT holds ${raw.length} bytes, expected ${stride * height}`);
  for (let y = 0; y < height; y++) if (raw[y * stride] !== 0) throw new Error(`row ${y} uses filter ${raw[y * stride]}`);
  const px = (x, y) => {
    const i = y * stride + 1 + x * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  return { width, height, chunks, px };
}

// An RGB buffer (row-major, no filter bytes) of a decoded image.
export function rgbOf(img) {
  const out = Buffer.alloc(img.width * img.height * 3);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) out.set(img.px(x, y), (y * img.width + x) * 3);
  }
  return out;
}
