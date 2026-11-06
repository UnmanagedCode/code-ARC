import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readTar, TarError, writeTar } from '../src/tar.js';
import { chunksOf, longWheelName, paxEntry, paxRecord, rawEntry, rawTar, ROOT_REQS } from './_bundle.mjs';
import { freshEnv } from './_helpers.mjs';
import { parsePins } from '../src/bundle.js';

async function collect(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(c);
  return Buffer.concat(chunks);
}

async function readAll(buf) {
  const entries = [];
  await readTar(chunksOf(buf), {
    onEntry: async (e) => {
      const rec = { ...e, body: [] };
      entries.push(rec);
      return e.type === 'file' ? { write: (c) => { rec.body.push(Buffer.from(c)); }, end: () => { rec.body = Buffer.concat(rec.body); } } : null;
    },
  });
  return entries;
}

const file = (p, s) => ({ type: 'file', path: p, size: Buffer.byteLength(s), read: async function* body() { yield Buffer.from(s); } });

test('writeTar/readTar round-trip files and dirs, including a path needing the prefix field', async (t) => {
  const long = `games/${'a'.repeat(90)}/${'b'.repeat(60)}/source.py`;
  const big = 'x'.repeat(1300);
  const tar = await collect(writeTar([{ type: 'dir', path: 'games' }, file('manifest.json', '{}'), file(long, big), file('empty', '')]));
  assert.equal(tar.length % 10240, 0, 'padded to a whole record');
  const got = await readAll(tar);
  assert.deepEqual(got.map((e) => [e.type, e.path, e.size]), [['dir', 'games', 0], ['file', 'manifest.json', 2], ['file', long, 1300], ['file', 'empty', 0]]);
  assert.equal(got[2].body.toString(), big);
  assert.equal(got[3].body.length, 0);

  const env = await freshEnv(t);
  const p = path.join(env.tmp, 'x.tar');
  await fs.writeFile(p, tar);
  let listing = null;
  try {
    listing = execFileSync('tar', ['-tf', p], { encoding: 'utf8' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (listing !== null) assert.deepEqual(listing.trim().split('\n'), ['games/', 'manifest.json', long, 'empty'], 'system tar reads it');
});

test('readTar rejects symlink, hardlink, char/block device, FIFO, pax global, GNU, and malformed pax headers', async () => {
  const kinds = { 1: /hard link/, 2: /symlink/, 3: /character device/, 4: /block device/, 6: /FIFO/, x: /pax header/, g: /pax global/, L: /GNU long name/, K: /GNU long link/, S: /sparse/ };
  for (const [type, re] of Object.entries(kinds)) {
    const linkname = type === '1' || type === '2' ? '/etc/passwd' : '';
    const buf = rawTar([{ name: 'ok.txt', body: Buffer.from('fine') }, { name: 'games/fake/maze/fake.py', type, linkname }]);
    const seen = [];
    await assert.rejects(
      readTar(chunksOf(buf), { onEntry: async (e) => { seen.push(e.path); return null; } }),
      (e) => e instanceof TarError && re.test(e.message),
      `typeflag ${type}`,
    );
    assert.deepEqual(seen, ['ok.txt'], `typeflag ${type} never reaches onEntry`);
  }
  // A regular-file typeflag carrying a link name is refused too.
  await assert.rejects(readTar(chunksOf(rawTar([{ name: 'a', linkname: 'b' }])), { onEntry: async () => null }), /link name/);
});

test('readTar rejects bad checksum, non-ustar magic, base-256 size, NUL in a name, truncation', async () => {
  const cases = [
    [{ name: 'a', checksumDelta: 1 }, /checksum/],
    [{ name: 'a', magic: 'ustar ', version: ' \0' }, /ustar/],
    [{ name: 'a', magic: 'xxxxx\0' }, /ustar/],
    [{ name: 'a', sizeField: Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]) }, /octal/],
    [{ name: 'a\0b' }, /NUL/],
    [{ name: 'café' }, /printable/],
  ];
  for (const [entry, re] of cases) {
    await assert.rejects(readTar(chunksOf(rawTar([entry])), { onEntry: async () => null }), (e) => e instanceof TarError && re.test(e.message), JSON.stringify(entry));
  }
  const whole = rawTar([{ name: 'a', body: Buffer.from('hello world') }]);
  await assert.rejects(readTar(chunksOf(whole.subarray(0, 512 + 5)), { onEntry: async () => null }), /truncated/);
  await assert.rejects(readTar(chunksOf(rawTar([{ name: 'a' }], { end: false })), { onEntry: async () => null }), /truncated/);
  await assert.rejects(readTar(chunksOf(Buffer.concat([rawTar([{ name: 'a' }]), rawEntry({ name: 'late' })])), { onEntry: async () => null }), /after the end/);
});

test('writeTar/readTar round-trip a path past ustar\'s name field via a pax path record; system tar and Python tarfile list it', async (t) => {
  const long = `wheels/${longWheelName(parsePins(ROOT_REQS))}`;
  assert.ok(Buffer.byteLength(long.split('/')[1]) > 100, 'the name really exceeds ustar\'s 100-byte field');
  const tar = await collect(writeTar([file(long, 'wheel bytes'), file('short.txt', 'after')]));
  const got = await readAll(tar);
  assert.deepEqual(got.map((e) => [e.type, e.path, e.size]), [['file', long, 11], ['file', 'short.txt', 5]], 'the pax path applies to one entry only');
  assert.equal(got[0].body.toString(), 'wheel bytes');
  assert.equal(got[1].body.toString(), 'after');

  const env = await freshEnv(t);
  const p = path.join(env.tmp, 'x.tar');
  await fs.writeFile(p, tar);
  const py = execFileSync('python3', ['-I', '-c', 'import tarfile,sys; print("\\n".join(tarfile.open(sys.argv[1]).getnames()))', p], { encoding: 'utf8' });
  assert.deepEqual(py.trim().split('\n'), [long, 'short.txt'], 'Python tarfile lists the full name');
  let listing = null;
  try {
    listing = execFileSync('tar', ['-tf', p], { encoding: 'utf8' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (listing !== null) assert.deepEqual(listing.trim().split('\n'), [long, 'short.txt'], 'system tar lists the full name');
});

test('writeTar emits no pax header when every path fits ustar', async () => {
  const names = ['manifest.json', `games/${'a'.repeat(90)}/${'b'.repeat(60)}/source.py`, `wheels/${'w'.repeat(93)}`];
  const tar = await collect(writeTar([{ type: 'dir', path: 'games' }, ...names.map((n) => file(n, 'abc'))]));
  let off = 0;
  let headers = 0;
  while (!tar.subarray(off, off + 512).every((b) => b === 0)) {
    const flag = String.fromCharCode(tar[off + 156]);
    assert.notEqual(flag, 'x');
    off += 512 + (flag === '5' ? 0 : 512);
    headers++;
  }
  assert.equal(headers, 4);
});

test('writeTar refuses a path whose pax record exceeds one block, and a too-long directory', async () => {
  await assert.rejects(collect(writeTar([file(`wheels/${'a'.repeat(600)}.whl`, 'x')])), (e) => e instanceof TarError && /too long/.test(e.message));
  await assert.rejects(collect(writeTar([{ type: 'dir', path: `d/${'a'.repeat(300)}` }])), (e) => e instanceof TarError && /too long/.test(e.message));
});

test('readTar accepts only a single path pax record before a regular file', async () => {
  const long = `wheels/${'a'.repeat(120)}.whl`;
  const good = paxEntry(paxRecord('path', long));
  const body = { name: 'short', body: Buffer.from('hi') };
  const run = async (entries) => {
    const seen = [];
    const p = readTar(chunksOf(rawTar(entries)), { onEntry: async (e) => { seen.push(e.path); return null; } });
    return { seen, p };
  };
  const ok = await run([{ name: 'ok.txt' }, good, body]);
  await ok.p;
  assert.deepEqual(ok.seen, ['ok.txt', long], 'positive control: the pax path replaces the header name');

  const bad = long.slice(0, 20);
  const cases = [
    ['linkpath', [paxEntry(paxRecord('linkpath', '/etc/passwd')), body], /pax header/],
    ['size', [paxEntry(paxRecord('size', '9')), body], /pax header/],
    ['GNU.sparse.size', [paxEntry(paxRecord('GNU.sparse.size', '1')), body], /pax header/],
    ['path+linkpath', [paxEntry(paxRecord('path', bad) + paxRecord('linkpath', '/etc/x')), body], /pax header/],
    ['path+path', [paxEntry(paxRecord('path', bad) + paxRecord('path', bad)), body], /pax header/],
    ['length off by one', [paxEntry(paxRecord('path', bad, { len: paxRecord('path', bad).length + 1 })), body], /pax header/],
    ['leading-zero length', [paxEntry(paxRecord('path', bad, { len: `0${paxRecord('path', bad).length}` })), body], /pax header/],
    ['no trailing newline', [paxEntry(paxRecord('path', bad).slice(0, -1)), body], /pax header/],
    ['control byte', [paxEntry(paxRecord('path', 'a\x01b')), body], /pax header/],
    ['non-ASCII byte', [paxEntry(paxRecord('path', 'a\xe9b')), body], /pax header/],
    ['size 0', [paxEntry(''), body], /pax header/],
    ['size 513', [paxEntry(`${'1'.repeat(512)}\n`), body], /pax header/],
    ['then symlink', [good, { name: 'l', type: '2', linkname: '/etc/passwd' }], /symlink/],
    ['then hard link', [good, { name: 'l', type: '1', linkname: '/etc/passwd' }], /hard link/],
    ['then dir', [good, { name: 'd/', type: '5' }], /pax header/],
    ['then pax', [good, good, body], /pax header/],
    ['then pax global', [good, { name: 'g', type: 'g' }], /pax global/],
    ['then end of archive', [good], /pax header/],
    ['path ending in /', [paxEntry(paxRecord('path', 'a/b/')), body], /ends in \//],
  ];
  for (const [label, entries, re] of cases) {
    const r = await run([{ name: 'ok.txt' }, ...entries]);
    await assert.rejects(r.p, (e) => e instanceof TarError && re.test(e.message), label);
    assert.deepEqual(r.seen, ['ok.txt'], `${label}: only the entry before the pax header reached onEntry`);
  }
});
