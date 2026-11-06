// The offline bundle's policy, export and import (src/bundle.js,
// src/bundleExport.js, src/bundleImport.js, scripts/bundle.mjs). Network-free:
// export runs on a scripted spawn and a fake fetch, its game download on the
// real helper over the fake toolkit; everything writes into temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PIP_VERSION } from '../src/bootstrap.js';
import {
  BUNDLE_LIMITS, BundleError, bundleInstallArgs, LICENSE_NOTICE, locateBundle, normName, openRegularFile, parsePins, validateBundlePath, verifyBundle,
} from '../src/bundle.js';
import { exportBundle } from '../src/bundleExport.js';
import { importBundle } from '../src/bundleImport.js';
import { captureLog, FAKES, freshEnv, ROOT } from './_helpers.mjs';
import { longWheelName, makeBundleDir, mkfifo, packDir, paxEntry, paxRecord, rawTar, ROOT_REQS, scriptedSpawn, settlesWithin, sha, snapshot, TARGET } from './_bundle.mjs';

const FAKE_GAMES = ['fake-maze', 'fake-lose', 'fake-reset0', 'fake-evil', 'fake-hang', 'fake-slow', 'fake-crash', 'fake-noisy', 'fake-429', 'fake-closed'];
const PIP_BYTES = Buffer.from('pip zipapp bytes for export');
const PIP = { url: 'https://example.invalid/pip.pyz', sha256: sha(PIP_BYTES), version: PIP_VERSION };
const pipFetch = async () => ({ ok: true, status: 200, body: [PIP_BYTES] });
const quiet = captureLog();
const code = (c) => (e) => e instanceof BundleError && e.code === c;
const codeMatching = (c, re) => (e) => e instanceof BundleError && e.code === c && re.test(e.message);

// The commands export runs, scripted: python probes, pip download (a wheel
// per pin, `skipPin` left out), venv and install; the game helper runs for
// real on python3 over the fake toolkit.
function exportSpawn({ skipPin = null } = {}) {
  const installs = [];
  const s = scriptedSpawn((cmd, args) => {
    if (args[0] === '--version') return cmd === 'python3.13' ? { code: 0, out: 'Python 3.13.5\n' } : { code: 127 };
    if (args[0] === '-I' && args[1] === '-c') return { code: 0, out: `${JSON.stringify(TARGET)}\n` };
    if (args[0] === '-I' && args[2] === 'download') {
      return (async () => {
        const req = await fs.readFile(args[args.indexOf('-r') + 1], 'utf8');
        const dest = args[args.indexOf('-d') + 1];
        const pins = parsePins(req);
        const longPin = pins.reduce((a, b) => (b.norm.length > a.norm.length ? b : a));
        for (const p of pins) {
          if (p.name === skipPin) continue;
          const name = p.norm === longPin.norm ? longWheelName(pins) : `${normName(p.name).replace(/-/g, '_')}-${p.version}-py3-none-any.whl`;
          await fs.writeFile(path.join(dest, name), `wheel ${p.name}`);
        }
        return { code: 0 };
      })();
    }
    if (args[0] === '-m' && args[1] === 'venv') {
      return fs.mkdir(path.join(args[3], 'bin'), { recursive: true }).then(() => ({ code: 0 }));
    }
    if (args[1] === 'install') {
      installs.push([cmd, ...args]);
      return { code: 0 };
    }
    if (cmd.endsWith(path.join('venv', 'bin', 'python')) && args[1]?.endsWith('bundle_games.py')) return { real: true, cmd: 'python3' };
    return { code: 1, err: `unexpected command ${cmd} ${args.join(' ')}` };
  });
  return { ...s, installs };
}

const exportOpts = (spawn, extra = {}) => ({
  checkoutDir: ROOT, spawn, fetch: pipFetch, log: quiet, testToolkitDir: FAKES, pip: PIP, ...extra,
});

const stagingLeft = async (dataDir) => (await fs.readdir(dataDir).catch(() => [])).filter((n) => n.startsWith('.bundle-'));

test('validateBundlePath rejects .., absolute, drive-letter, backslash, too-deep, unknown top dir, wrong file kind', () => {
  for (const ok of ['pip/pip-26.3.pyz', 'wheels/numpy-2.5.4-cp313-cp313-manylinux_2_17_x86_64.whl', 'games/ls20/1234/metadata.json', 'games/ls20/1234/ls20.py', 'games/ls20/metadata.json']) {
    assert.doesNotThrow(() => validateBundlePath(ok), ok);
  }
  const bad = ['../escape', 'games/../../x.py', 'games/./a/b.py', '/abs/x.py', 'C:/x/y.py', 'games\\a\\b.py', 'games/a b/c.py', 'games/a/b/c/d.py',
    'games/a/b/c/d/e/f.py', 'secrets/a.py', 'pip/a.whl', 'wheels/a.pyz', 'wheels/sub/a.whl', 'games/a/run.sh', 'games/a.py', '', 'manifest.json', 'games/caf\u00e9/a/b.py'];
  for (const p of bad) assert.throws(() => validateBundlePath(p), code('BUNDLE_INVALID'), p);
});

test('export produces a self-contained archive whose manifest describes exactly its contents', async (t) => {
  const env = await freshEnv(t);
  const out = path.join(env.tmp, 'out', 'b.arcbundle');
  await fs.mkdir(path.dirname(out));
  const { spawn, installs } = exportSpawn();
  const r = await exportBundle({ out, ...exportOpts(spawn) });
  assert.equal(r.out, out);
  assert.equal(r.games, FAKE_GAMES.length);
  assert.deepEqual(await fs.readdir(path.dirname(out)), ['b.arcbundle'], 'no partial file left');

  const imported = await importBundle({ archive: out, dataDir: env.dataDir, checkoutDir: ROOT, log: quiet, expectId: r.id });
  assert.equal(imported.id, r.id);
  const m = imported.manifest;
  assert.ok(m.wheels.some((w) => Buffer.byteLength(path.posix.basename(w.file)) > 100), 'a wheel name past ustar\'s 100-byte field survives export and import');
  assert.deepEqual(m.target, TARGET);
  assert.equal(m.requirements_sha256, sha(ROOT_REQS));
  assert.equal(m.notice, LICENSE_NOTICE);
  assert.equal(m.pip.file, `pip/pip-${PIP_VERSION}.pyz`);
  assert.deepEqual(await fs.readFile(path.join(imported.dir, 'pip', `pip-${PIP_VERSION}.pyz`)), PIP_BYTES);
  assert.deepEqual(m.wheels.map((w) => normName(w.project)).sort(), parsePins(ROOT_REQS).map((p) => p.norm).sort(), 'a wheel per pin');
  assert.deepEqual(m.games.map((g) => g.game_id).sort(), [...FAKE_GAMES].sort());
  const onDisk = await snapshot(imported.dir);
  delete onDisk['manifest.json'];
  assert.deepEqual(onDisk, Object.fromEntries(m.files.map((f) => [f.path, f.sha256])), 'manifest lists exactly the files, with their hashes');
  for (const f of m.files) assert.equal((await fs.stat(path.join(imported.dir, f.path))).size, f.size);
  for (const g of m.games) {
    const meta = JSON.parse(await fs.readFile(path.join(imported.dir, g.dir, 'metadata.json'), 'utf8'));
    assert.equal(meta.game_id, g.game_id);
    assert.ok(!('local_dir' in meta), 'no exporter path in metadata');
    assert.ok(existsSync(path.join(imported.dir, g.dir, 'fake.py')), `${g.game_id} source`);
  }
  assert.equal(installs.length, 1, 'the toolkit was installed from the staged files');
  const inst = installs[0];
  const wheelsDir = inst[inst.indexOf('--find-links') + 1];
  assert.deepEqual(inst.slice(1), bundleInstallArgs({ pyz: inst[1], wheelsDir, requirementsFile: inst[inst.length - 1] }));
  assert.match(inst[1], /stage\/pip\/pip-[^/]+\.pyz$/);
  assert.match(wheelsDir, /stage\/wheels$/);
});

test('export with no <out> writes a timestamped .arcbundle into the default dir', async (t) => {
  const env = await freshEnv(t);
  const defaultOutDir = path.join(env.tmp, 'bundles');
  const clock = { now: () => Date.UTC(2026, 0, 2, 3, 4, 5) };
  const r = await exportBundle({ defaultOutDir, clock, ...exportOpts(exportSpawn().spawn) });
  assert.equal(r.out, path.join(defaultOutDir, 'code-arc-20260102-030405.arcbundle'));
  assert.deepEqual(await fs.readdir(defaultOutDir), ['code-arc-20260102-030405.arcbundle']);
});

test('export refuses an output not ending in .arcbundle, or an existing one', async (t) => {
  const env = await freshEnv(t);
  const fetched = [];
  const fetch = async (u) => { fetched.push(u); throw new Error('no'); };
  const { spawn, calls } = exportSpawn();
  for (const out of [path.join(env.tmp, 'x.tar.gz'), 'relative.arcbundle', path.join(env.tmp, '.arcbundle')]) {
    await assert.rejects(exportBundle({ out, ...exportOpts(spawn, { fetch }) }), code('BUNDLE_OUT_INVALID'), out);
  }
  const existing = path.join(env.tmp, 'have.arcbundle');
  await fs.writeFile(existing, 'keep');
  await assert.rejects(exportBundle({ out: existing, ...exportOpts(spawn, { fetch }) }), code('BUNDLE_OUT_INVALID'));
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep');
  assert.deepEqual([fetched.length, calls.length], [0, 0], 'refused before any work');

  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bundle.mjs'), 'export', path.join(env.tmp, 'x.tar.gz')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, CONDUCTOR_PLUGIN_DATA_DIR: env.dataDir },
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^BUNDLE_OUT_INVALID: /m);
  assert.match(cli.stderr, /^Fix: /m);
});

test('the default export location is gitignored', () => {
  for (const p of ['bundles/code-arc-20260102-030405.arcbundle', 'any/dir/x.arcbundle', 'bundles/.code-arc-x.abc.partial.arcbundle']) {
    assert.doesNotThrow(() => execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT }), p);
  }
});

test('export fails loudly and leaves no output when a pin has no wheel', async (t) => {
  const env = await freshEnv(t);
  const dir = path.join(env.tmp, 'out');
  await fs.mkdir(dir);
  const out = path.join(dir, 'b.arcbundle');
  await assert.rejects(exportBundle({ out, ...exportOpts(exportSpawn({ skipPin: 'numpy' }).spawn) }), codeMatching('BUNDLE_EXPORT_FAILED', /numpy/));
  assert.deepEqual(await fs.readdir(dir), []);
});

async function bundleArchive(env, name = 'b', opts = {}) {
  const src = await makeBundleDir(path.join(env.tmp, `src-${name}`), opts);
  const archive = await packDir(src.dir, path.join(env.tmp, `${name}.arcbundle`));
  return { ...src, archive };
}

test('import installs a verified bundle atomically', async (t) => {
  const env = await freshEnv(t);
  const b = await bundleArchive(env);
  const r = await importBundle({ archive: b.archive, dataDir: env.dataDir, checkoutDir: ROOT, log: quiet });
  assert.equal(r.id, b.id);
  assert.equal(r.id, sha(b.manifestBuf));
  assert.equal(r.dir, path.join(env.dataDir, 'bundle'));
  assert.deepEqual(await snapshot(r.dir), await snapshot(b.dir));
  assert.deepEqual(await stagingLeft(env.dataDir), []);

  const other = path.join(env.tmp, 'cli-data');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bundle.mjs'), 'import', b.archive], {
    encoding: 'utf8', env: { PATH: process.env.PATH, CONDUCTOR_PLUGIN_DATA_DIR: other },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.includes(b.id), 'prints the bundle id');
  assert.ok(cli.stdout.includes(LICENSE_NOTICE), 'prints the license notice');
  assert.deepEqual(await snapshot(path.join(other, 'bundle')), await snapshot(b.dir));
});

test('import refuses an existing bundle without --replace; --replace swaps it', async (t) => {
  const env = await freshEnv(t);
  const a = await bundleArchive(env, 'a', { games: ['fake-maze'] });
  const b = await bundleArchive(env, 'b', { games: ['fake-evil'] });
  await importBundle({ archive: a.archive, dataDir: env.dataDir, checkoutDir: ROOT, log: quiet });
  await assert.rejects(importBundle({ archive: b.archive, dataDir: env.dataDir, checkoutDir: ROOT, log: quiet }), code('BUNDLE_EXISTS'));
  const slot = path.join(env.dataDir, 'bundle');
  assert.deepEqual(await snapshot(slot), await snapshot(a.dir), 'untouched');
  const r = await importBundle({ archive: b.archive, dataDir: env.dataDir, checkoutDir: ROOT, replace: true, log: quiet });
  assert.equal(r.id, b.id);
  assert.deepEqual(await snapshot(slot), await snapshot(b.dir), 'wholly the new bundle');
  assert.deepEqual(await stagingLeft(env.dataDir), []);
});

test('import with a wrong --expect-sha256 is refused before extraction', async (t) => {
  const env = await freshEnv(t);
  const b = await bundleArchive(env);
  await assert.rejects(importBundle({ archive: b.archive, dataDir: env.dataDir, checkoutDir: ROOT, expectId: 'f'.repeat(64), log: quiet }), code('BUNDLE_ID_MISMATCH'));
  assert.ok(!existsSync(path.join(env.dataDir, 'bundle')));
  assert.deepEqual(await stagingLeft(env.dataDir), []);
  const ok = await importBundle({ archive: b.archive, dataDir: env.dataDir, checkoutDir: ROOT, expectId: b.id, log: quiet });
  assert.equal(ok.id, b.id);
});

test('malicious archives are rejected and leave nothing behind', async (t) => {
  const env = await freshEnv(t);
  const b = await makeBundleDir(path.join(env.tmp, 'src'));
  const fileBytes = async (p) => fs.readFile(path.join(b.dir, ...p.split('/')));
  const listed = b.manifest.files.map((f) => f.path);
  const source = 'games/fake/maze/fake.py';
  const manifest = { name: 'manifest.json', body: b.manifestBuf };
  const all = async () => Promise.all(listed.map(async (p) => ({ name: p, body: await fileBytes(p) })));
  const sentinel = path.join(env.tmp, 'escape.py');
  const cases = {
    'parent traversal': [manifest, { name: '../../escape.py', body: Buffer.from('x') }, /bad path|\.\./],
    'absolute path': [manifest, { name: sentinel, body: Buffer.from('x') }, /bad path/],
    'drive letter': [manifest, { name: 'C:/games/x.py', body: Buffer.from('x') }, /bad path/],
    symlink: [manifest, { name: source, type: '2', linkname: sentinel }, /symlink/],
    hardlink: [manifest, { name: source, type: '1', linkname: '/etc/passwd' }, /hard link/],
    'pax parent traversal': [manifest, paxEntry(paxRecord('path', `../../${'e'.repeat(110)}.py`)), { name: 'x', body: Buffer.from('x') }, /bad path|\.\./],
    'pax absolute path': [manifest, paxEntry(paxRecord('path', `${sentinel}/${'e'.repeat(110)}.py`)), { name: 'x', body: Buffer.from('x') }, /bad path/],
    'pax path over pathMax': [manifest, paxEntry(paxRecord('path', `wheels/${'a'.repeat(250)}.whl`)), { name: 'x', body: Buffer.from('x') }, /bad path/],
    'pax before a symlink': [manifest, paxEntry(paxRecord('path', source)), { name: 'x', type: '2', linkname: sentinel }, /symlink/],
    'unlisted file': [manifest, { name: 'games/fake/zzz/fake.py', body: Buffer.from('x') }, /unlisted/],
    'manifest not first': [{ name: source, body: await fileBytes(source) }, manifest, /first entry/],
    duplicate: [manifest, { name: source, body: await fileBytes(source) }, { name: source, body: await fileBytes(source) }, /duplicate/],
    'size differs from the manifest': [manifest, { name: source, body: Buffer.from('a different length') }, /bytes in the archive/],
    'missing listed file': [manifest, /missing file/],
  };
  for (const [label, spec] of Object.entries(cases)) {
    const re = spec.pop();
    const archive = path.join(env.tmp, `${label.replace(/\W/g, '_')}.arcbundle`);
    const entries = label === 'missing listed file' ? [manifest, ...(await all()).filter((e) => e.name !== source)] : spec;
    await fs.writeFile(archive, gzipSync(rawTar(entries)));
    await assert.rejects(importBundle({ archive, dataDir: env.dataDir, checkoutDir: ROOT, log: quiet }), codeMatching('BUNDLE_INVALID', re), label);
    assert.ok(!existsSync(path.join(env.dataDir, 'bundle')), `${label}: no slot`);
    assert.deepEqual(await stagingLeft(env.dataDir), [], `${label}: no staging`);
    assert.ok(!existsSync(sentinel) && !existsSync(path.join(env.dataDir, 'escape.py')) && !existsSync(path.join(env.tmp, '..', 'escape.py')), `${label}: nothing outside`);
  }
  const notGzip = path.join(env.tmp, 'plain.arcbundle');
  await fs.writeFile(notGzip, rawTar([manifest]));
  await assert.rejects(importBundle({ archive: notGzip, dataDir: env.dataDir, checkoutDir: ROOT, log: quiet }), codeMatching('BUNDLE_INVALID', /gzip/));
});

test('an entry whose bytes differ from the manifest is BUNDLE_HASH_MISMATCH', async (t) => {
  const env = await freshEnv(t);
  const b = await makeBundleDir(path.join(env.tmp, 'src'));
  const source = 'games/fake/maze/fake.py';
  const entries = [{ name: 'manifest.json', body: b.manifestBuf }];
  for (const f of b.manifest.files) {
    const body = await fs.readFile(path.join(b.dir, f.path));
    entries.push({ name: f.path, body: f.path === source ? Buffer.from(body.toString().replace('fake', 'evil')) : body });
  }
  const archive = path.join(env.tmp, 'tampered.arcbundle');
  await fs.writeFile(archive, gzipSync(rawTar(entries)));
  await assert.rejects(importBundle({ archive, dataDir: env.dataDir, checkoutDir: ROOT, log: quiet }), codeMatching('BUNDLE_HASH_MISMATCH', /fake\.py/));
  assert.ok(!existsSync(path.join(env.dataDir, 'bundle')));
  assert.deepEqual(await stagingLeft(env.dataDir), []);
});

test('import enforces file-size, total-size, file-count and ratio limits', async (t) => {
  const env = await freshEnv(t);
  const zeros = Buffer.alloc(2 * 1024 * 1024);
  const b = await makeBundleDir(path.join(env.tmp, 'src'));
  // The ratio case: one game source of zeros (honest hashes), so only the
  // decompression check can stop it.
  const big = await makeBundleDir(path.join(env.tmp, 'zeros'), { games: ['fake-maze'] });
  await fs.writeFile(path.join(big.dir, 'games', 'fake', 'maze', 'fake.py'), zeros);
  const meta = JSON.parse(big.manifestBuf);
  const f = meta.files.find((x) => x.path === 'games/fake/maze/fake.py');
  Object.assign(f, { size: zeros.length, sha256: sha(zeros) });
  await fs.writeFile(path.join(big.dir, 'manifest.json'), JSON.stringify(meta));
  const archive = await packDir(b.dir, path.join(env.tmp, 'b.arcbundle'));
  const zipped = await packDir(big.dir, path.join(env.tmp, 'zeros.arcbundle'));
  const biggest = Math.max(...b.manifest.files.map((x) => x.size));
  const total = b.manifest.files.reduce((s, x) => s + x.size, 0);
  const cases = [
    [archive, { fileMaxBytes: biggest - 1 }, /out of bounds/],
    [archive, { totalMaxBytes: total - 1 }, /total over|decompression limit/],
    [archive, { filesMax: b.manifest.files.length - 1 }, /over \d+ files/],
    [archive, { archiveMaxBytes: 10 }, /over 10 bytes/],
    [zipped, { ratioMax: 2 }, /decompression limit/],
  ];
  for (const [file, over, re] of cases) {
    await assert.rejects(importBundle({ archive: file, dataDir: env.dataDir, checkoutDir: ROOT, limits: { ...BUNDLE_LIMITS, ...over }, log: quiet }), codeMatching('BUNDLE_INVALID', re), JSON.stringify(over));
    assert.ok(!existsSync(path.join(env.dataDir, 'bundle')));
    assert.deepEqual(await stagingLeft(env.dataDir), []);
  }
  // The same zeros archive imports under the default limits.
  await importBundle({ archive: zipped, dataDir: env.dataDir, checkoutDir: ROOT, log: quiet });
});

test('verifyBundle: tampered → HASH_MISMATCH; extra file, inner symlink, missing file, unpinned wheel → INVALID; other requirements → STALE; bundle under <data>/toolkit → INVALID', async (t) => {
  const env = await freshEnv(t);
  const fresh = async (name, opts) => (await makeBundleDir(path.join(env.tmp, name), opts)).dir;
  const verify = (dir, requirementsText = ROOT_REQS) => verifyBundle(dir, { requirementsText });
  const source = ['games', 'fake', 'maze', 'fake.py'];

  const ok = await fresh('ok');
  assert.equal((await verify(ok)).id, sha(await fs.readFile(path.join(ok, 'manifest.json'))));

  const tampered = await fresh('tampered');
  await fs.writeFile(path.join(tampered, ...source), '# fake game sourcE for fake-maze\n');
  await assert.rejects(verify(tampered), codeMatching('BUNDLE_HASH_MISMATCH', /fake\.py has sha256/));

  const extra = await fresh('extra');
  await fs.writeFile(path.join(extra, 'games', 'fake', 'maze', 'extra.py'), 'x');
  await assert.rejects(verify(extra), codeMatching('BUNDLE_INVALID', /unexpected file/));

  const extraDir = await fresh('extradir');
  await fs.mkdir(path.join(extraDir, 'games', 'other'));
  await assert.rejects(verify(extraDir), codeMatching('BUNDLE_INVALID', /unexpected directory/));

  const link = await fresh('link');
  await fs.rm(path.join(link, ...source));
  await fs.symlink('/etc/hostname', path.join(link, ...source));
  await assert.rejects(verify(link), codeMatching('BUNDLE_INVALID', /not a regular file/));

  const missing = await fresh('missing');
  await fs.rm(path.join(missing, ...source));
  await assert.rejects(verify(missing), codeMatching('BUNDLE_INVALID', /missing file/));

  const unpinned = await fresh('unpinned');
  const wheel = Buffer.from('an unpinned wheel');
  await fs.writeFile(path.join(unpinned, 'wheels', 'extra_pkg-1.0-py3-none-any.whl'), wheel);
  const um = JSON.parse(await fs.readFile(path.join(unpinned, 'manifest.json'), 'utf8'));
  um.files.push({ path: 'wheels/extra_pkg-1.0-py3-none-any.whl', size: wheel.length, sha256: sha(wheel) });
  um.wheels.push({ file: 'wheels/extra_pkg-1.0-py3-none-any.whl', project: 'extra-pkg', version: '1.0' });
  await fs.writeFile(path.join(unpinned, 'manifest.json'), JSON.stringify(um));
  await assert.rejects(verify(unpinned), codeMatching('BUNDLE_INVALID', /not pinned by requirements/));

  await assert.rejects(verify(ok, `${ROOT_REQS}extra-pkg==1.0\n`), code('BUNDLE_STALE'));

  const toolkitDir = path.join(env.dataDir, 'toolkit');
  const inside = await fresh(path.join('data', 'toolkit', 'bundle'));
  await assert.rejects(locateBundle({ envPath: inside, dataDirPath: null, toolkitDir }), codeMatching('BUNDLE_INVALID', /toolkit/));
  const slotLink = path.join(env.dataDir, 'bundle');
  await fs.symlink(ok, slotLink);
  await assert.rejects(locateBundle({ envPath: null, dataDirPath: slotLink, toolkitDir }), codeMatching('BUNDLE_INVALID', /symlink/));
});

test('a FIFO in place of a listed game file, or handed to the open helper, is BUNDLE_INVALID promptly', async (t) => {
  const env = await freshEnv(t);
  const b = await makeBundleDir(path.join(env.tmp, 'fifo'));
  const source = path.join(b.dir, 'games', 'fake', 'maze', 'fake.py');
  await fs.rm(source);
  if (!mkfifo(source)) {
    t.skip('this platform cannot make FIFOs');
    return;
  }
  await assert.rejects(settlesWithin(verifyBundle(b.dir, { requirementsText: ROOT_REQS }), 2000, 'verifyBundle'), codeMatching('BUNDLE_INVALID', /fake\.py is not a regular file/));
  // The helper every verifier open goes through refuses it too (the
  // swapped-in-after-the-walk case), without blocking on the open.
  await assert.rejects(settlesWithin(openRegularFile(source, 'games/fake/maze/fake.py'), 2000, 'openRegularFile'), codeMatching('BUNDLE_INVALID', /not a regular file/));
});

test('verifyBundle stops when its signal aborts', async (t) => {
  const env = await freshEnv(t);
  const b = await makeBundleDir(path.join(env.tmp, 'ok'));
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(verifyBundle(b.dir, { requirementsText: ROOT_REQS, signal: pre.signal }), { name: 'AbortError' });
  const mid = new AbortController();
  const running = verifyBundle(b.dir, { requirementsText: ROOT_REQS, signal: mid.signal });
  mid.abort();
  await assert.rejects(running, { name: 'AbortError' });
});
