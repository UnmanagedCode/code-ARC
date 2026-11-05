import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createBootstrap, DIVERGED_FIX, FIX, PIP_VERSION } from '../src/bootstrap.js';
import { bundleInstallArgs } from '../src/bundle.js';
import { captureLog, freshEnv, json, startApp, until } from './_helpers.mjs';
import { makeBundleDir, settlesWithin, TARGET } from './_bundle.mjs';

const REQS = 'arc-agi==0.9.9\narcengine==0.9.3\n';
const sha = (s) => createHash('sha256').update(s).digest('hex');
// Above any real pid_max, so a group kill can never reach a real process.
const FAKE_PID = 4194304 + 4242;

// A spawn stand-in: `handler(cmd, args)` returns {code, out}, or 'hang'.
function fakeSpawn(handler) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    const child = new EventEmitter();
    child.pid = FAKE_PID;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', null));
    Promise.resolve(handler(cmd, args)).then((r) => {
      if (r === 'hang') return;
      if (r.out) child.stdout.write(r.out);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', r.code));
    });
    return child;
  };
  return { spawn, calls };
}

async function checkout(t) {
  const env = await freshEnv(t);
  const dir = path.join(env.tmp, 'checkout');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'requirements.txt'), REQS);
  return { env, dir };
}

const stamp = (reqs = REQS) => JSON.stringify({ requirements_sha256: sha(reqs), python_version: '3.13.5' });
const noFetch = () => { throw new Error('fetch must not be called'); };
const quiet = captureLog();

test('a matching stamp is ready without spawning anything', async (t) => {
  const { dir } = await checkout(t);
  await fs.mkdir(path.join(dir, '.venv', 'bin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.venv', 'code-arc-stamp.json'), stamp());
  const { spawn, calls } = fakeSpawn(() => ({ code: 0 }));
  const b = createBootstrap({ checkoutDir: dir, spawn, fetch: noFetch, log: quiet });
  await b.run();
  assert.equal(b.status().state, 'ready');
  assert.equal(b.python(), path.join(dir, '.venv', 'bin', 'python'));
  assert.equal(calls.length, 0);
});

test('a shared (symlinked) venv with a matching stamp is used as is', async (t) => {
  const { env, dir } = await checkout(t);
  const shared = path.join(env.tmp, 'shared-venv');
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, 'code-arc-stamp.json'), stamp());
  await fs.symlink(shared, path.join(dir, '.venv'));
  const b = createBootstrap({ checkoutDir: dir, spawn: fakeSpawn(() => ({ code: 0 })).spawn, fetch: noFetch, log: quiet });
  await b.run();
  assert.equal(b.status().state, 'ready');
});

test('a symlinked venv whose stamp differs is diverged and never written through', async (t) => {
  const { env, dir } = await checkout(t);
  const shared = path.join(env.tmp, 'shared-venv');
  await fs.mkdir(shared);
  const old = stamp('arc-agi==0.0.1\n');
  await fs.writeFile(path.join(shared, 'code-arc-stamp.json'), old);
  await fs.writeFile(path.join(shared, 'marker'), 'keep');
  await fs.symlink(shared, path.join(dir, '.venv'));
  const { spawn, calls } = fakeSpawn(() => ({ code: 0 }));
  const b = createBootstrap({ checkoutDir: dir, spawn, fetch: noFetch, log: quiet });
  await b.run();
  const s = b.status();
  assert.equal(s.state, 'diverged');
  assert.equal(s.fix, DIVERGED_FIX);
  assert.match(s.fix, /rm \.venv/);
  assert.equal(b.python(), null);
  assert.equal(calls.length, 0);
  assert.deepEqual((await fs.readdir(shared)).sort(), ['code-arc-stamp.json', 'marker']);
  assert.equal(await fs.readFile(path.join(shared, 'code-arc-stamp.json'), 'utf8'), old);
});

test('no Python >= 3.12 fails with PYTHON_MISSING', async (t) => {
  const { dir } = await checkout(t);
  const { spawn } = fakeSpawn((cmd) => (cmd === 'python3' ? { code: 0, out: 'Python 3.10.4\n' } : { code: 127 }));
  const b = createBootstrap({ checkoutDir: dir, spawn, fetch: noFetch, log: quiet });
  await b.run();
  assert.equal(b.status().state, 'failed');
  assert.equal(b.status().code, 'PYTHON_MISSING');
  assert.equal(b.status().fix, FIX);
});

function installer(dir, { install = { code: 0 }, onSmoke = () => {} } = {}) {
  return fakeSpawn(async (cmd, args) => {
    if (args[0] === '--version') return { code: 0, out: 'Python 3.13.5\n' };
    if (args[0] === '-m' && args[1] === 'venv') {
      await fs.mkdir(path.join(dir, '.venv', 'bin'), { recursive: true });
      return { code: 0 };
    }
    if (args[1] === 'install') return install;
    if (args[0] === '-I') {
      onSmoke();
      return { code: 0 };
    }
    return { code: 1 };
  });
}

const bodyFetch = (bytes) => async () => ({ ok: true, status: 200, body: [bytes] });

test('a pip.pyz hash mismatch fails before installing anything', async (t) => {
  const { dir } = await checkout(t);
  const { spawn, calls } = installer(dir);
  const b = createBootstrap({ checkoutDir: dir, spawn, fetch: bodyFetch(Buffer.from('tampered')), pip: { url: 'https://example.invalid/pip.pyz', sha256: sha('genuine') }, log: quiet });
  await b.run();
  assert.equal(b.status().state, 'failed');
  assert.equal(b.status().code, 'HASH_MISMATCH');
  assert.ok(!calls.some((c) => c.includes('install')));
  assert.ok(!existsSync(path.join(dir, '.venv', 'code-arc-stamp.json')));
});

test('a full install ends with the stamp, written last', async (t) => {
  const { dir } = await checkout(t);
  let stampAtSmoke = null;
  const { spawn, calls } = installer(dir, { onSmoke: () => { stampAtSmoke = existsSync(path.join(dir, '.venv', 'code-arc-stamp.json')); } });
  const pyz = Buffer.from('pip zipapp bytes');
  const b = createBootstrap({ checkoutDir: dir, spawn, fetch: bodyFetch(pyz), pip: { url: 'https://example.invalid/pip.pyz', sha256: sha(pyz) }, log: quiet });
  await b.run();
  assert.equal(b.status().state, 'ready');
  assert.equal(stampAtSmoke, false);
  const written = JSON.parse(await fs.readFile(path.join(dir, '.venv', 'code-arc-stamp.json'), 'utf8'));
  assert.equal(written.requirements_sha256, sha(REQS));
  const kinds = calls.map((c) => (c[1] === '--version' ? 'probe' : c[2] === 'venv' ? 'venv' : c[2] === 'install' ? 'install' : c[1] === '-I' ? 'smoke' : '?'));
  assert.deepEqual(kinds, ['probe', 'venv', 'install', 'smoke']);
  assert.deepEqual(await fs.readFile(path.join(dir, '.venv', 'pip.pyz')), pyz);
});

test('a failed install surfaces the output tail and writes no stamp', async (t) => {
  const { dir } = await checkout(t);
  const { spawn } = installer(dir, { install: { code: 1, out: 'ERROR: No matching distribution found for arc-agi==0.9.9\n' } });
  const pyz = Buffer.from('x');
  const b = createBootstrap({ checkoutDir: dir, spawn, fetch: bodyFetch(pyz), pip: { url: 'https://example.invalid/pip.pyz', sha256: sha(pyz) }, log: quiet });
  await b.run();
  assert.equal(b.status().code, 'INSTALL_FAILED');
  assert.match(b.status().detail, /No matching distribution/);
  assert.ok(!existsSync(path.join(dir, '.venv', 'code-arc-stamp.json')));
});

test('while installing, health answers and toolkit tools refuse TOOLKIT_NOT_READY', async (t) => {
  const { env, dir } = await checkout(t);
  const { spawn } = fakeSpawn(() => 'hang');
  const { url, mcp } = await startApp(t, { env, config: { checkoutDir: dir, python: null }, spawn });
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  await until(async () => (await json(`${url}/api/status`)).body.toolkit.state === 'installing');
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  const r = (await mcp('list_games')).result;
  assert.equal(r.code, 'TOOLKIT_NOT_READY');
  assert.equal(r.state, 'installing');
  assert.equal((await mcp('start_session', { game_id: 'fake-maze' })).result.code, 'TOOLKIT_NOT_READY');
  assert.equal((await json(`${url}/api/status`)).body.toolkit.state, 'installing');
});

test('failed and diverged installs refuse with detail and a fix', async (t) => {
  const failed = await checkout(t);
  const a = await startApp(t, { env: failed.env, config: { checkoutDir: failed.dir, python: null }, spawn: fakeSpawn(() => ({ code: 127 })).spawn });
  const fr = await (async () => { for (;;) { const r = (await a.mcp('list_games')).result; if (r.code !== 'TOOLKIT_NOT_READY') return r; await new Promise((x) => setTimeout(x, 10)); } })();
  assert.equal(fr.code, 'TOOLKIT_UNAVAILABLE');
  assert.match(fr.detail, /no Python/);
  assert.ok(fr.fix);

  const div = await checkout(t);
  const shared = path.join(div.env.tmp, 'shared');
  await fs.mkdir(shared);
  await fs.symlink(shared, path.join(div.dir, '.venv'));
  const b = await startApp(t, { env: div.env, config: { checkoutDir: div.dir, python: null }, spawn: fakeSpawn(() => ({ code: 0 })).spawn });
  const dr = await (async () => { for (;;) { const r = (await b.mcp('list_games')).result; if (r.code !== 'TOOLKIT_NOT_READY') return r; await new Promise((x) => setTimeout(x, 10)); } })();
  assert.equal(dr.code, 'DEPS_DIVERGED');
  assert.match(dr.fix, /rm \.venv/);
});

// A real detached child that never exits on its own, standing in for pip.
function hangingSpawn() {
  const pids = [];
  const spawn = (cmd, args, opts) => {
    const c = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], opts);
    pids.push(c.pid);
    return c;
  };
  return { spawn, pids };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stop() kills a running install step and settles run() as stopped', async (t) => {
  const { dir } = await checkout(t);
  const { spawn, pids } = hangingSpawn();
  const b = createBootstrap({ checkoutDir: dir, spawn, fetch: noFetch, log: quiet });
  const running = b.run();
  await until(() => pids.length === 1 && b.status().phase === 'python');
  assert.ok(alive(pids[0]));
  await b.stop();
  await running;
  assert.equal(b.status().state, 'stopped');
  await until(() => !alive(pids[0]));
  assert.equal(pids.length, 1, 'no further step started after stop');
  assert.ok(!existsSync(path.join(dir, '.venv', 'code-arc-stamp.json')));
});

test('app.close() leaves no bootstrap child behind', async (t) => {
  const { env, dir } = await checkout(t);
  const { spawn, pids } = hangingSpawn();
  const { app, close } = await startApp(t, { env, config: { checkoutDir: dir, python: null }, spawn });
  await until(() => pids.length === 1);
  await close();
  assert.equal(app.bootstrap.status().state, 'stopped');
  await until(() => !alive(pids[0]));
});

test('failed and diverged states carry their fix in api/status', async (t) => {
  const div = await checkout(t);
  const shared = path.join(div.env.tmp, 'shared');
  await fs.mkdir(shared);
  await fs.symlink(shared, path.join(div.dir, '.venv'));
  const { url } = await startApp(t, { env: div.env, config: { checkoutDir: div.dir, python: null }, spawn: fakeSpawn(() => ({ code: 0 })).spawn });
  const tk = await until(async () => { const b = (await json(`${url}/api/status`)).body.toolkit; return b.state === 'diverged' && b; });
  assert.equal(tk.fix, DIVERGED_FIX);
});

// -- offline bundle installs ---------------------------------------------------

const BUNDLE_PIP = Buffer.from('bundled pip zipapp');

// A checkout plus a bundle for its requirements; `bundle` locations for createBootstrap.
async function bundleCheckout(t, opts = {}) {
  const { env, dir } = await checkout(t);
  const b = await makeBundleDir(path.join(env.tmp, 'bundle'), { requirementsText: REQS, pipBytes: BUNDLE_PIP, ...opts });
  return { env, dir, b, bundle: { envPath: b.dir, dataDirPath: path.join(env.dataDir, 'bundle'), toolkitDir: path.join(env.dataDir, 'toolkit') } };
}

// Python probes answer `host` as the target; venv, install and smoke succeed.
function bundleInstaller(dir, { host = TARGET, versions = { python3: '3.13.5' }, onInstall = () => {} } = {}) {
  return fakeSpawn(async (cmd, args) => {
    if (args[0] === '--version') return versions[cmd] ? { code: 0, out: `Python ${versions[cmd]}\n` } : { code: 127 };
    if (args[0] === '-I' && args[1] === '-c' && args[2].includes('platform')) return { code: 0, out: `${JSON.stringify(host)}\n` };
    if (args[0] === '-m' && args[1] === 'venv') {
      await fs.mkdir(path.join(dir, '.venv', 'bin'), { recursive: true });
      return { code: 0 };
    }
    if (args[1] === 'install') {
      await onInstall(args);
      return { code: 0 };
    }
    if (args[0] === '-I') return { code: 0 };
    return { code: 1 };
  });
}

test('a bundle installs with --no-index from its own pip and wheels and never fetches', async (t) => {
  const { dir, b, bundle } = await bundleCheckout(t);
  let reqFile = null;
  const { spawn, calls } = bundleInstaller(dir, { onInstall: async (args) => { reqFile = await fs.readFile(args[args.length - 1], 'utf8'); } });
  const bs = createBootstrap({ checkoutDir: dir, bundle, spawn, fetch: noFetch, pip: { url: 'https://example.invalid/pip.pyz', sha256: sha(BUNDLE_PIP) }, log: quiet });
  await bs.run();
  const s = bs.status();
  assert.equal(s.state, 'ready', s.detail);
  assert.equal(s.source, 'bundle');
  assert.equal(s.bundle.id, b.id);
  assert.equal(s.bundle.location, 'env');
  assert.equal(bs.gamesDir(), path.join(b.dir, 'games'));
  const install = calls.find((c) => c[2] === 'install');
  const requirementsFile = path.join(dir, '.venv', 'code-arc-bundle-requirements.txt');
  assert.deepEqual(install, [path.join(dir, '.venv', 'bin', 'python'), ...bundleInstallArgs({
    pyz: path.join(b.dir, 'pip', `pip-${PIP_VERSION}.pyz`), wheelsDir: path.join(b.dir, 'wheels'), requirementsFile,
  })]);
  for (const flag of ['--isolated', '--no-index', '--require-hashes']) assert.ok(install.includes(flag), flag);
  const wheelSha = Object.fromEntries(b.manifest.files.map((f) => [f.path, f.sha256]));
  assert.deepEqual(reqFile.trim().split('\n'), b.manifest.wheels.map((w) => `${w.project}==${w.version} --hash=sha256:${wheelSha[w.file]}`));
  assert.ok(!calls.some((c) => c.join(' ').includes('download')), 'no download phase');
});

test('a platform mismatch fails before any venv is made', async (t) => {
  const { dir, bundle } = await bundleCheckout(t);
  const { spawn, calls } = bundleInstaller(dir, { host: { ...TARGET, machine: 'aarch64' } });
  const bs = createBootstrap({ checkoutDir: dir, bundle, spawn, fetch: noFetch, pip: { url: 'x', sha256: sha(BUNDLE_PIP) }, log: quiet });
  await bs.run();
  const s = bs.status();
  assert.equal(s.state, 'failed');
  assert.equal(s.code, 'BUNDLE_PLATFORM_MISMATCH');
  assert.match(s.detail, /aarch64/);
  assert.match(s.fix, /export the bundle on a machine matching this host/);
  assert.equal(bs.gamesDir(), null);
  assert.ok(!calls.some((c) => c[2] === 'venv'), 'no venv spawned');
  assert.ok(!existsSync(path.join(dir, '.venv')));
});

test('a bundle whose pip differs from the pinned pip is BUNDLE_STALE', async (t) => {
  const { dir, bundle } = await bundleCheckout(t);
  const { spawn, calls } = bundleInstaller(dir);
  const bs = createBootstrap({ checkoutDir: dir, bundle, spawn, fetch: noFetch, pip: { url: 'x', sha256: sha('the pinned pip') }, log: quiet });
  await bs.run();
  assert.equal(bs.status().state, 'failed');
  assert.equal(bs.status().code, 'BUNDLE_STALE');
  assert.equal(calls.length, 0, 'nothing ran');
});

test('with a bundle, python<target> is tried first', async (t) => {
  const { dir, bundle } = await bundleCheckout(t, { target: { ...TARGET, python: '3.12' } });
  const { spawn, calls } = bundleInstaller(dir, {
    host: { ...TARGET, python: '3.12' }, versions: { 'python3.13': '3.13.5', 'python3.12': '3.12.9', python3: '3.13.5' },
  });
  const bs = createBootstrap({ checkoutDir: dir, bundle, spawn, fetch: noFetch, pip: { url: 'x', sha256: sha(BUNDLE_PIP) }, log: quiet });
  await bs.run();
  assert.equal(bs.status().state, 'ready', bs.status().detail);
  assert.deepEqual(calls[0], ['python3.12', '--version']);
  assert.deepEqual(calls.find((c) => c[2] === 'venv').slice(0, 1), ['python3.12']);
});

test('stop() while the bundle is being verified settles promptly as stopped', async (t) => {
  const { dir, bundle } = await bundleCheckout(t);
  let seen = null;
  // A verification that never finishes on its own (a wedged filesystem).
  const verify = (d, opts) => {
    seen = opts.signal;
    return new Promise(() => {});
  };
  const { spawn, calls } = bundleInstaller(dir);
  const bs = createBootstrap({ checkoutDir: dir, bundle, verify, spawn, fetch: noFetch, pip: { url: 'x', sha256: sha(BUNDLE_PIP) }, log: quiet });
  const running = bs.run();
  await until(() => seen !== null);
  assert.deepEqual([bs.status().state, bs.status().phase], ['checking', 'bundle']);
  await settlesWithin(bs.stop(), 2000, 'stop()');
  await settlesWithin(running, 2000, 'run()');
  assert.equal(bs.status().state, 'stopped');
  assert.equal(seen.aborted, true, 'the verifier was told to stop');
  assert.equal(calls.length, 0);
});
