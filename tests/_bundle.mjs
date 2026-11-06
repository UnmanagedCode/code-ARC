// Offline-bundle fixtures: a bundle directory with real hashes, packing it,
// hand-built (malformed) tar archives, a fetch spy, and the fake toolkit's
// network switch and log.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, LICENSE_NOTICE, MANIFEST_FILE, normName, parsePins } from '../src/bundle.js';
import { PIP_VERSION } from '../src/bootstrap.js';
import { writeTar } from '../src/tar.js';
import { ROOT } from './_helpers.mjs';

export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const ROOT_REQS = readFileSync(path.join(ROOT, 'requirements.txt'), 'utf8');
export const TARGET = Object.freeze({ implementation: 'cpython', python: '3.13', system: 'linux', machine: 'x86_64', libc: 'glibc' });
const TITLES = { 'fake-maze': 'Fake Maze', 'fake-evil': 'Evil <img src=x onerror=alert(1)>' };

const write = async (root, rel, bytes) => {
  const p = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, bytes);
};

// Writes a complete, valid bundle into `dir`. `mutate(manifest)` may edit the
// manifest before it is written (its files are already hashed).
export async function makeBundleDir(dir, {
  requirementsText = ROOT_REQS, games = ['fake-maze', 'fake-evil'], target = TARGET, pipBytes = Buffer.from('fake pip zipapp'), mutate,
} = {}) {
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  const add = async (rel, bytes) => {
    const buf = Buffer.from(bytes);
    await write(dir, rel, buf);
    files.push({ path: rel, size: buf.length, sha256: sha(buf) });
  };
  const pipFile = `pip/pip-${PIP_VERSION}.pyz`;
  await add(pipFile, pipBytes);
  const wheels = [];
  for (const p of parsePins(requirementsText)) {
    const file = `wheels/${normName(p.name).replace(/-/g, '_')}-${p.version}-py3-none-any.whl`;
    await add(file, `fake wheel ${p.name}==${p.version}`);
    wheels.push({ file, project: p.name, version: p.version });
  }
  const gameEntries = [];
  for (const gid of games) {
    const [base, ver] = gid.split(/-(.*)/s);
    const gdir = `games/${base}/${ver}`;
    const title = TITLES[gid] || gid;
    await add(`${gdir}/metadata.json`, JSON.stringify({ game_id: gid, title, tags: [], date_downloaded: '2026-01-01T00:00:00+00:00' }, null, 2));
    await add(`${gdir}/${base}.py`, `# fake game source for ${gid}\n`);
    gameEntries.push({ game_id: gid, title, dir: gdir });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const pin = (n) => parsePins(requirementsText).find((p) => p.norm === n)?.version ?? '0';
  const manifest = {
    format: BUNDLE_FORMAT,
    format_version: BUNDLE_FORMAT_VERSION,
    notice: LICENSE_NOTICE,
    created_at: '2026-01-01T00:00:00.000Z',
    target: { ...target },
    requirements_sha256: sha(requirementsText),
    toolkit: { arc_agi: pin('arc-agi'), arcengine: pin('arcengine') },
    pip: { version: PIP_VERSION, file: pipFile },
    wheels,
    games: gameEntries,
    files,
  };
  mutate?.(manifest);
  const buf = Buffer.from(JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(dir, MANIFEST_FILE), buf);
  return { dir, id: sha(buf), manifest, manifestBuf: buf };
}

// Packs a bundle dir the way export does: manifest first, then sorted files.
export async function packDir(dir, out) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
  const entries = [MANIFEST_FILE, ...manifest.files.map((f) => f.path)];
  const chunks = [];
  for await (const c of writeTar(await Promise.all(entries.map(async (p) => {
    const bytes = await fs.readFile(path.join(dir, ...p.split('/')));
    return { type: 'file', path: p, size: bytes.length, read: async function* body() { yield bytes; } };
  })))) chunks.push(c);
  await fs.writeFile(out, gzipSync(Buffer.concat(chunks)));
  return out;
}

// One hand-built ustar header + body, for archives writeTar would never make.
// `type` is the typeflag character; overrides tamper with single fields.
export function rawEntry({
  name, type = '0', body = Buffer.alloc(0), size, prefix = '', linkname = '', magic = 'ustar\0', version = '00', sizeField, checksumDelta = 0,
}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'latin1');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  if (sizeField) sizeField.copy(h, 124);
  else h.write(`${(size ?? body.length).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write(type, 156, 1, 'latin1');
  h.write(linkname, 157, 100, 'latin1');
  h.write(magic, 257, 6, 'latin1');
  h.write(version, 263, 2, 'latin1');
  h.write(prefix, 345, 155, 'latin1');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${(sum + checksumDelta).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
}

// A pax record "<len> key=value\n"; `len` overrides the (correct) length.
export const paxRecord = (key, value, { len } = {}) => {
  const tail = ` ${key}=${value}\n`;
  let n = tail.length + 1;
  for (let m = String(n).length + tail.length; m !== n; m = String(n).length + tail.length) n = m;
  return `${len ?? n}${tail}`;
};

// A pax extended header (typeflag x) carrying `body`.
export const paxEntry = (body, overrides) => rawEntry({ name: '././@PaxHeader', type: 'x', body: Buffer.from(body), ...overrides });

// The real manylinux wheel file name of the pin with the longest normalised name.
export function longWheelName(pins) {
  const p = pins.reduce((a, b) => (b.norm.length > a.norm.length ? b : a));
  return `${normName(p.name).replace(/-/g, '_')}-${p.version}-cp313-cp313-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl`;
}

// A raw archive of `entries` (rawEntry inputs or Buffers), with the end marker.
export function rawTar(entries, { end = true } = {}) {
  const parts = entries.map((e) => (Buffer.isBuffer(e) ? e : rawEntry(e)));
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const chunksOf = (buf, size = 777) => Readable.from((function* split() {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}()));

// A fetch that records and refuses every call.
export function fetchSpy() {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    throw new Error('fetch must not be called');
  };
  return { fetch, calls };
}

// The fake toolkit's network switch: every request it would send fails.
export async function netDown(dataDir) {
  await fs.mkdir(path.join(dataDir, 'toolkit'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'toolkit', 'fake-net-down'), '');
}

export async function readNet(dataDir) {
  try {
    return (await fs.readFile(path.join(dataDir, 'toolkit', 'net.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// Every file under `dir` as {relative path: sha256} (a tamper-evident snapshot).
export async function snapshot(dir, rel = '') {
  const out = {};
  for (const ent of await fs.readdir(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) Object.assign(out, await snapshot(dir, r));
    else out[r] = sha(await fs.readFile(path.join(dir, r)));
  }
  return out;
}

// A spawn stand-in: `handler(cmd, args, opts)` returns {code, out, err}, or
// {real: true} to run the command for real (with the same options).
export function scriptedSpawn(handler) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    const r = handler(cmd, args, opts);
    if (r && r.real) return nodeSpawn(r.cmd || cmd, args, opts);
    const child = new EventEmitter();
    child.pid = 4194304 + 4343;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', null));
    Promise.resolve(r).then((res) => {
      if (res.out) child.stdout.write(res.out);
      if (res.err) child.stderr.write(res.err);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', res.code));
    });
    return child;
  };
  return { spawn, calls };
}

// Makes a FIFO at `p` (mkfifo, else Python's os.mkfifo); false if the
// platform can't.
export function mkfifo(p) {
  for (const [cmd, args] of [['mkfifo', [p]], ['python3', ['-I', '-c', 'import os,sys; os.mkfifo(sys.argv[1])', p]]]) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.status === 0) return true;
  }
  return false;
}

// Rejects if `p` hasn't settled within `ms` (a test deadline, not a product bound).
export function settlesWithin(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
}
