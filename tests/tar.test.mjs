import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readTar, TarError, writeTar } from '../src/tar.js';
import { chunksOf, rawEntry, rawTar } from './_bundle.mjs';
import { freshEnv } from './_helpers.mjs';

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

test('readTar rejects symlink, hardlink, char/block device, FIFO, pax and GNU long-name entries', async () => {
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
