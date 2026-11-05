// Builds a bundle archive on an online machine: the pinned pip zipapp, a
// wheel per requirements.txt pin for this host's Python, and every game's
// source as the toolkit downloads it. Work happens in a private scratch dir;
// the archive appears at `out` only once it is complete and verified.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  BootstrapError, fetchVerified, findPython, PIP_PYZ_MAX_BYTES, PIP_PYZ_SHA256, PIP_PYZ_URL, PIP_VERSION, probeTarget,
} from './bootstrap.js';
import {
  BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, BundleError, bundleInstallArgs, checkWheelsMatchPins, hashedRequirements,
  LICENSE_NOTICE, MANIFEST_FILE, parsePins, sha256, validateBundlePath, verifyBundle, wheelProject,
} from './bundle.js';
import { CHECKOUT_DIR } from './config.js';
import { DETAIL_MAX, SIDECAR_LINE_MAX } from './limits.js';
import { createRunner } from './proc.js';
import { ENV_ALLOWLIST } from './sidecar.js';
import { writeTar } from './tar.js';

export const EXPORT_TIMEOUTS = Object.freeze({
  probe: 10000, download: 60000, pipDownload: 900000, venv: 120000, install: 900000, games: 1800000,
});

const failed = (msg) => new BundleError('BUNDLE_EXPORT_FAILED', msg);

// UTC yyyymmdd-HHMMSS.
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

async function hashFile(p) {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(p)) {
    size += chunk.length;
    h.update(chunk);
  }
  return { size, sha256: h.digest('hex') };
}

// Every regular file under `dir` as a bundle-relative path; anything else fails.
async function listFiles(dir, rel = '') {
  const out = [];
  for (const ent of await fs.readdir(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...await listFiles(dir, r));
    else if (ent.isFile()) out.push(r);
    else throw failed(`the staged bundle has a non-regular entry ${r}`);
  }
  return out;
}

export async function exportBundle({
  out = null,
  defaultOutDir = path.join(CHECKOUT_DIR, 'bundles'),
  checkoutDir = CHECKOUT_DIR,
  spawn = nodeSpawn,
  fetch = globalThis.fetch,
  log = console,
  apiKey = null,
  pythonOverride = null,
  testToolkitDir = null,
  pip = { url: PIP_PYZ_URL, sha256: PIP_PYZ_SHA256, version: PIP_VERSION },
  timeouts = EXPORT_TIMEOUTS,
  clock = { now: Date.now },
} = {}) {
  if (out === null) {
    await fs.mkdir(defaultOutDir, { recursive: true, mode: 0o700 });
    out = path.join(defaultOutDir, `code-arc-${stamp(clock.now())}${BUNDLE_EXT}`);
  }
  if (!path.isAbsolute(out) || !out.endsWith(BUNDLE_EXT) || path.basename(out) === BUNDLE_EXT) {
    throw new BundleError('BUNDLE_OUT_INVALID', `the output must be an absolute path ending in ${BUNDLE_EXT} (got ${out})`);
  }
  if (await exists(out)) throw new BundleError('BUNDLE_OUT_INVALID', `${out} already exists`);

  const requirementsText = await fs.readFile(path.join(checkoutDir, 'requirements.txt'), 'utf8');
  const pins = parsePins(requirementsText);
  const redact = (s) => (apiKey ? String(s).split(apiKey).join('[redacted]') : String(s));
  const runner = createRunner({ spawn, log, logPrefix: '[code-arc export] ', cwd: checkoutDir });
  const run = runner.run;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'code-arc-export-'));
  const stage = path.join(scratch, 'stage');
  let partial = null;

  async function step(what, cmd, args, opts) {
    const r = await run(cmd, args, opts);
    if (r.code !== 0) {
      const why = r.timedOut ? `timed out after ${opts.timeoutMs} ms` : r.error ? r.error.message : `exited ${r.code}`;
      throw failed(`${what} ${why}: ${redact(r.tail).slice(-DETAIL_MAX)}`);
    }
    return r;
  }

  try {
    for (const d of ['pip', 'wheels', 'games']) await fs.mkdir(path.join(stage, d), { recursive: true, mode: 0o700 });

    // pip: the zipapp this checkout pins, verified.
    log.log(`[code-arc export] fetching pip ${pip.version}`);
    const pyzRel = `pip/pip-${pip.version}.pyz`;
    const pyz = path.join(stage, ...pyzRel.split('/'));
    const pyzBytes = await fetchVerified({ fetch, url: pip.url, sha256: pip.sha256, maxBytes: PIP_PYZ_MAX_BYTES, signal: AbortSignal.timeout(timeouts.download) });
    await fs.writeFile(pyz, pyzBytes, { mode: 0o600 });

    // The interpreter whose wheels are bundled, and its target.
    const py = await findPython(run, undefined, { timeoutMs: timeouts.probe });
    const target = await probeTarget(run, py.cmd, timeouts.probe);
    if (!target) throw failed(`could not read the target of ${py.cmd}`);
    log.log(`[code-arc export] target: ${target.implementation} ${target.python} ${target.system} ${target.machine}${target.libc ? ` ${target.libc}` : ''}`);

    // Wheels: requirements.txt is the full frozen set, hence --no-deps.
    const reqFile = path.join(checkoutDir, 'requirements.txt');
    const wheelsDir = path.join(stage, 'wheels');
    await step('pip download', py.cmd, ['-I', pyz, 'download', '--isolated', '--disable-pip-version-check', '--no-input',
      '--only-binary=:all:', '--no-deps', '-r', reqFile, '-d', wheelsDir], { timeoutMs: timeouts.pipDownload, stream: true });
    const wheelFiles = (await fs.readdir(wheelsDir)).sort();
    const pinByNorm = new Map(pins.map((p) => [p.norm, p]));
    const wheels = wheelFiles.map((f) => {
      const wp = wheelProject(f);
      if (!wp) throw failed(`pip downloaded ${f}, which is not a wheel`);
      const pin = pinByNorm.get(wp.norm);
      return { file: `wheels/${f}`, project: pin ? pin.name : wp.norm, version: wp.version };
    });
    try {
      checkWheelsMatchPins({ wheels }, pins);
    } catch (e) {
      throw failed(`the downloaded wheels do not match requirements.txt: ${e.message}`);
    }

    // The toolkit, installed from the staged files only (a self-test of the
    // bundle's install), unless a ready interpreter is injected.
    let gamesPython = pythonOverride;
    if (!gamesPython) {
      const venv = path.join(scratch, 'venv');
      await step('venv', py.cmd, ['-m', 'venv', '--without-pip', venv], { timeoutMs: timeouts.venv });
      const files = [{ path: pyzRel, ...await hashFile(pyz) }];
      for (const w of wheels) files.push({ path: w.file, ...await hashFile(path.join(stage, ...w.file.split('/'))) });
      const hashed = path.join(scratch, 'requirements-hashed.txt');
      await fs.writeFile(hashed, hashedRequirements(requirementsText, { files, wheels }), { mode: 0o600 });
      gamesPython = path.join(venv, 'bin', 'python');
      await step('install', gamesPython, bundleInstallArgs({ pyz, wheelsDir, requirementsFile: hashed }), { timeoutMs: timeouts.install, stream: true });
    }

    // Games: the toolkit downloads each one into stage/games.
    const runDir = path.join(scratch, 'run');
    await fs.mkdir(runDir, { mode: 0o700 });
    const env = {};
    for (const k of ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k];
    if (testToolkitDir) env.CODE_ARC_TEST_TOOLKIT_DIR = testToolkitDir;
    log.log('[code-arc export] downloading every game');
    const g = await run(gamesPython, ['-I', path.join(checkoutDir, 'sidecar', 'bundle_games.py')], {
      cwd: runDir, env, timeoutMs: timeouts.games, stdoutMax: SIDECAR_LINE_MAX,
      input: `${JSON.stringify({ api_key: apiKey, environments_dir: path.join(stage, 'games') })}\n`,
    });
    let reply = null;
    try {
      reply = JSON.parse(g.stdout.trim().split('\n').pop());
    } catch { /* reported below */ }
    if (g.code !== 0 || !reply?.ok) {
      const why = reply?.detail || (g.timedOut ? `timed out after ${timeouts.games} ms` : g.error ? g.error.message : `exited ${g.code}`);
      throw failed(redact(`downloading the games failed: ${why}. ${g.tail.slice(-DETAIL_MAX)}`).slice(0, DETAIL_MAX * 2));
    }

    // The manifest describes exactly what is staged.
    const files = [];
    let total = 0;
    for (const rel of (await listFiles(stage)).sort()) {
      try {
        validateBundlePath(rel);
      } catch (e) {
        throw failed(`the toolkit staged an unexpected file: ${e.message}`);
      }
      const h = await hashFile(path.join(stage, ...rel.split('/')));
      total += h.size;
      files.push({ path: rel, size: h.size, sha256: h.sha256 });
    }
    const pinVersion = (norm) => pinByNorm.get(norm)?.version ?? null;
    const manifest = {
      format: BUNDLE_FORMAT,
      format_version: BUNDLE_FORMAT_VERSION,
      notice: LICENSE_NOTICE,
      created_at: new Date(clock.now()).toISOString(),
      target,
      requirements_sha256: sha256(requirementsText),
      toolkit: { arc_agi: pinVersion('arc-agi'), arcengine: pinVersion('arcengine') },
      pip: { version: pip.version, file: pyzRel },
      wheels,
      games: reply.games,
      files,
    };
    const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(stage, MANIFEST_FILE), manifestBuf, { mode: 0o600 });
    const { id } = await verifyBundle(stage, { requirementsText });
    log.log(`[code-arc export] ${files.length} files, ${total} bytes, ${manifest.games.length} games`);

    // Pack, then link into place (never over an existing file).
    const entries = [{ type: 'file', path: MANIFEST_FILE, size: manifestBuf.length, read: async function* manifestBytes() { yield manifestBuf; } }];
    for (const f of files) entries.push({ type: 'file', path: f.path, size: f.size, read: () => createReadStream(path.join(stage, ...f.path.split('/'))) });
    partial = path.join(path.dirname(out), `.${path.basename(out, BUNDLE_EXT)}.${randomBytes(6).toString('hex')}.partial${BUNDLE_EXT}`);
    const fh = await fs.open(partial, 'wx', 0o600);
    await pipeline(Readable.from(writeTar(entries)), createGzip(), fh.createWriteStream());
    try {
      await fs.link(partial, out);
    } catch (e) {
      if (e.code === 'EEXIST') throw new BundleError('BUNDLE_OUT_INVALID', `${out} already exists`);
      throw e;
    }
    return { id, out, games: manifest.games.length, files: files.length, manifest };
  } catch (e) {
    if (e instanceof BundleError || e instanceof BootstrapError) throw e;
    throw failed(redact(e.message || e));
  } finally {
    runner.stopAll();
    if (partial) await fs.rm(partial, { force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
