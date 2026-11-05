// A minimal POSIX ustar writer and a fail-closed reader: regular files and
// directories only, streamed, no dependencies. The reader rejects every other
// entry kind (links, devices, FIFOs, pax and GNU extension headers) rather
// than skipping it.
const BLOCK = 512;
const RECORD = 10240;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const SIZE_MAX = 8 ** 11 - 1;
const TYPES = { '0': 'file', '\0': 'file', '5': 'dir' };
const TYPE_NAMES = {
  '1': 'hard link', '2': 'symlink', '3': 'character device', '4': 'block device', '6': 'FIFO', '7': 'contiguous file',
  x: 'pax header', g: 'pax global header', L: 'GNU long name', K: 'GNU long link', S: 'GNU sparse file',
};

export class TarError extends Error {}

function octal(buf, off, len, value) {
  buf.write(value.toString(8).padStart(len - 1, '0'), off, len - 1, 'ascii');
  buf[off + len - 1] = 0;
}

function splitPath(p) {
  if (Buffer.byteLength(p) <= NAME_MAX) return { prefix: '', name: p };
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= PREFIX_MAX && name.length > 0 && Buffer.byteLength(name) <= NAME_MAX) return { prefix, name };
  }
  throw new TarError(`path too long for ustar: ${p.slice(0, 80)}…`);
}

function header({ type, path, size }) {
  const h = Buffer.alloc(BLOCK);
  const { prefix, name } = splitPath(type === 'dir' ? `${path}/` : path);
  if (!/^[\x20-\x7e]+$/.test(path)) throw new TarError(`path is not printable ASCII: ${JSON.stringify(path)}`);
  if (type === 'file' && (!Number.isSafeInteger(size) || size < 0 || size > SIZE_MAX)) throw new TarError(`bad size for ${path}`);
  h.write(name, 0, NAME_MAX, 'ascii');
  octal(h, 100, 8, type === 'dir' ? 0o755 : 0o644);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, type === 'dir' ? 0 : size);
  octal(h, 136, 12, 0);
  h[156] = (type === 'dir' ? '5' : '0').charCodeAt(0);
  h.write('ustar\0', 257, 6, 'binary');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, PREFIX_MAX, 'ascii');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

// Yields the archive's bytes. `entries`: {type:'file'|'dir', path, size, read: () => AsyncIterable<Buffer>}.
export async function* writeTar(entries) {
  let written = 0;
  for await (const e of entries) {
    yield header(e);
    written += BLOCK;
    if (e.type !== 'file') continue;
    let n = 0;
    for await (const chunk of e.read()) {
      n += chunk.length;
      if (n > e.size) throw new TarError(`${e.path} grew past its size ${e.size}`);
      yield chunk;
    }
    if (n !== e.size) throw new TarError(`${e.path} is ${n} bytes, expected ${e.size}`);
    written += n;
    const pad = (BLOCK - (n % BLOCK)) % BLOCK;
    if (pad) {
      yield Buffer.alloc(pad);
      written += pad;
    }
  }
  const end = 2 * BLOCK + ((RECORD - ((written + 2 * BLOCK) % RECORD)) % RECORD);
  yield Buffer.alloc(end);
}

function byteReader(iterable) {
  const it = iterable[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  let done = false;
  async function fill(min) {
    while (buf.length < min && !done) {
      const r = await it.next();
      if (r.done) done = true;
      else buf = buf.length ? Buffer.concat([buf, r.value]) : Buffer.from(r.value);
    }
  }
  return {
    async exact(n) {
      await fill(n);
      if (buf.length < n) throw new TarError('the archive is truncated');
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    async some(max) {
      await fill(1);
      if (!buf.length) throw new TarError('the archive is truncated');
      const n = Math.min(max, buf.length);
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    async drainZeros() {
      for (;;) {
        await fill(1);
        if (!buf.length) return;
        if (buf.some((b) => b !== 0)) throw new TarError('data after the end-of-archive marker');
        buf = Buffer.alloc(0);
      }
    },
  };
}

const isZero = (b) => b.every((x) => x === 0);

function field(h, off, len, what) {
  const raw = h.subarray(off, off + len);
  const nul = raw.indexOf(0);
  const end = nul === -1 ? len : nul;
  if (nul !== -1 && !isZero(raw.subarray(nul))) throw new TarError(`${what} has a NUL inside it`);
  const s = raw.subarray(0, end).toString('latin1');
  if (!/^[\x20-\x7e]*$/.test(s)) throw new TarError(`${what} is not printable ASCII`);
  return s;
}

function parseOctal(h, off, len, what) {
  const s = h.subarray(off, off + len).toString('latin1');
  if (!/^[ \0]*[0-7]+[ \0]*$/.test(s)) throw new TarError(`${what} is not an octal number`);
  return Number.parseInt(s.replace(/[ \0]/g, ''), 8);
}

function parseHeader(h) {
  const stored = parseOctal(h, 148, 8, 'checksum');
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  if (stored !== unsigned && stored !== signed) throw new TarError('header checksum mismatch');
  if (h.subarray(257, 263).toString('latin1') !== 'ustar\0' || h.subarray(263, 265).toString('latin1') !== '00') {
    throw new TarError('not a POSIX ustar header');
  }
  const flag = String.fromCharCode(h[156]);
  const type = TYPES[flag];
  if (!type) throw new TarError(`unsupported entry type ${JSON.stringify(flag)}${TYPE_NAMES[flag] ? ` (${TYPE_NAMES[flag]})` : ''}`);
  if (!isZero(h.subarray(157, 257))) throw new TarError('entry has a link name');
  const size = parseOctal(h, 124, 12, 'size');
  const name = field(h, 0, NAME_MAX, 'name');
  const prefix = field(h, 345, PREFIX_MAX, 'prefix');
  let p = prefix ? `${prefix}/${name}` : name;
  if (type === 'dir') {
    if (size !== 0) throw new TarError(`directory ${p} has a size`);
    p = p.replace(/\/$/, '');
  } else if (p.endsWith('/')) {
    throw new TarError(`file ${p} ends in /`);
  }
  if (!p) throw new TarError('entry has an empty name');
  return { type, path: p, size };
}

// Reads an archive from an async iterable of Buffers. For each entry,
// `await onEntry({type, path, size})` returns a sink {write(buf), end()} (or
// null); file bytes are awaited into it in order.
export async function readTar(chunks, { onEntry }) {
  const r = byteReader(chunks);
  for (;;) {
    const h = await r.exact(BLOCK);
    if (isZero(h)) {
      if (!isZero(await r.exact(BLOCK))) throw new TarError('malformed end-of-archive marker');
      await r.drainZeros();
      return;
    }
    const entry = parseHeader(h);
    const sink = await onEntry(entry);
    if (entry.type !== 'file') continue;
    let left = entry.size;
    while (left > 0) {
      const chunk = await r.some(left);
      left -= chunk.length;
      if (sink) await sink.write(chunk);
    }
    if (sink) await sink.end();
    const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
    if (pad) await r.exact(pad);
  }
}
