// Builds the Python venv the sidecar runs in, asynchronously, so health and
// the UI answer the whole time. State: checking → installing → ready, or
// failed / diverged. Never throws: a failure is a state.
//
// With an offline bundle (src/bundle.js, docs/bundle.md) the bundle is
// verified first, and the venv is installed from its pip and wheels with no
// download; an invalid bundle is a failed state, never a fall back to the web.
//
// The venv lives at <checkout>/.venv; worktrees may share the main checkout's
// through a symlink, which is never written through (see the deps rule in
// docs/architecture.md).
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BundleError, bundleInstallArgs, bundleSummary, checkTarget, hashedRequirements, locateBundle, TARGET_PROBE_ARGS, verifyBundle,
} from './bundle.js';
import { DETAIL_MAX } from './limits.js';
import { createRunner } from './proc.js';

export const PIP_VERSION = '26.3';
export const PIP_PYZ_URL = `https://bootstrap.pypa.io/pip/zipapp/pip-${PIP_VERSION}.pyz`;
export const PIP_PYZ_SHA256 = 'be510f6d23d345eeabdd3eec2599a3ca2df3cbc98c4afbe2631561ca12e744d7';
export const PIP_PYZ_MAX_BYTES = 20 * 1024 * 1024;
const MIN_PYTHON = [3, 12];
export const PYTHON_CANDIDATES = Object.freeze(['python3.13', 'python3.12', 'python3']);
// The pip requirements file written into the venv for a bundle install.
const BUNDLE_REQUIREMENTS = 'code-arc-bundle-requirements.txt';
const TARGET_OUT_MAX = 4096;

export const DEFAULT_TIMEOUTS = Object.freeze({ probe: 10000, venv: 120000, download: 60000, install: 600000, smoke: 60000 });

// The `fix` shown with a failed or diverged state (status, refusals, banner).
export const FIX = 'see the detail; then restart the plugin, or run `node scripts/setup.mjs` in the plugin checkout';
export const DIVERGED_FIX = 'in this worktree: `rm .venv` (removes only this worktree\'s symlink), then restart the plugin or run `node scripts/setup.mjs`';
export const DIVERGED_DETAIL = "this worktree's requirements.txt differs from the shared venv the .venv symlink points to";

export class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The first of `candidates` that is a Python >= MIN_PYTHON: {cmd, version}.
// `run` is a runner's run (src/proc.js).
export async function findPython(run, candidates = PYTHON_CANDIDATES, { timeoutMs = DEFAULT_TIMEOUTS.probe } = {}) {
  for (const cand of candidates) {
    const r = await run(cand, ['--version'], { timeoutMs });
    const m = r.code === 0 && /Python (\d+)\.(\d+)\.(\d+)/.exec(r.tail);
    if (!m) continue;
    const [maj, min] = [Number(m[1]), Number(m[2])];
    if (maj > MIN_PYTHON[0] || (maj === MIN_PYTHON[0] && min >= MIN_PYTHON[1])) return { cmd: cand, version: `${m[1]}.${m[2]}.${m[3]}` };
  }
  throw new BootstrapError('PYTHON_MISSING', `no Python >= ${MIN_PYTHON.join('.')} found (tried ${candidates.join(', ')}); install one and restart the plugin`);
}

// Downloads `url` (at most `maxBytes`) and checks its sha256; resolves the bytes.
export async function fetchVerified({ fetch, url, sha256: want, maxBytes, signal }) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    throw new BootstrapError('DOWNLOAD_FAILED', `could not fetch ${url}: ${e.message}`);
  }
  if (!res.ok) throw new BootstrapError('DOWNLOAD_FAILED', `${url} answered ${res.status}`);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw new BootstrapError('DOWNLOAD_FAILED', `${url} is over ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk));
    }
  } catch (e) {
    if (e instanceof BootstrapError) throw e;
    throw new BootstrapError('DOWNLOAD_FAILED', `reading ${url} failed: ${e.message}`);
  }
  const buf = Buffer.concat(chunks);
  const got = sha256(buf);
  if (got !== want) throw new BootstrapError('HASH_MISMATCH', `${url} has sha256 ${got}, expected ${want}`);
  return buf;
}

// The interpreter's target ({implementation, python, system, machine, libc}) or null.
export async function probeTarget(run, cmd, timeoutMs) {
  const r = await run(cmd, TARGET_PROBE_ARGS, { timeoutMs, stdoutMax: TARGET_OUT_MAX });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

export function createBootstrap({
  checkoutDir,
  pythonOverride = null,
  bundle = null, // {envPath, dataDirPath, toolkitDir} (bundleLocations in src/bundle.js), or null
  spawn = nodeSpawn,
  fetch = globalThis.fetch,
  log = console,
  timeouts = DEFAULT_TIMEOUTS,
  pip = { url: PIP_PYZ_URL, sha256: PIP_PYZ_SHA256 },
  onChange = () => {},
}) {
  const venv = path.join(checkoutDir, '.venv');
  const venvPython = path.join(venv, 'bin', 'python');
  const stampFile = path.join(venv, 'code-arc-stamp.json');
  let status = { state: 'checking', phase: 'stamp', detail: null, fix: null, python: null, code: null, source: null, bundle: null };
  let running = null;
  // The verified bundle in use, or null.
  let active = null;
  // stop(): no new children, live ones killed, the download aborted, and no
  // further state change except `stopped`.
  let stopped = false;
  const abort = new AbortController();
  const runner = createRunner({ spawn, log, logPrefix: '[code-arc bootstrap] ', cwd: checkoutDir });
  const run = runner.run;

  function set(next) {
    if (stopped && next.state !== 'stopped') return;
    status = { ...status, ...next };
    onChange(status);
  }

  function checkStopped() {
    if (stopped) throw new BootstrapError('STOPPED', 'bootstrap stopped');
  }

  async function readStamp() {
    try {
      return JSON.parse(await fs.readFile(stampFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function download(dest) {
    let buf;
    try {
      buf = await fetchVerified({
        fetch, url: pip.url, sha256: pip.sha256, maxBytes: PIP_PYZ_MAX_BYTES,
        signal: AbortSignal.any([AbortSignal.timeout(timeouts.download), abort.signal]),
      });
    } catch (e) {
      checkStopped();
      throw e;
    }
    await fs.writeFile(dest, buf, { mode: 0o600 });
  }

  async function step(phase, cmd, args, timeoutMs, code) {
    set({ state: 'installing', phase });
    const r = await run(cmd, args, { timeoutMs, stream: true });
    checkStopped();
    if (r.code !== 0) {
      const why = r.timedOut ? `timed out after ${timeoutMs} ms` : r.error ? r.error.message : `exited ${r.code}`;
      throw new BootstrapError(code, `${phase} ${why}: ${r.tail.slice(-DETAIL_MAX)}`);
    }
  }

  // Locates and verifies the bundle (if any); sets `source` and `bundle`.
  async function useBundle(reqText) {
    if (!bundle) {
      set({ source: 'web' });
      return;
    }
    set({ state: 'checking', phase: 'bundle' });
    let loc = null;
    try {
      loc = await locateBundle(bundle);
      if (!loc) {
        set({ source: 'web' });
        return;
      }
      const { id, manifest } = await verifyBundle(loc.dir, { requirementsText: reqText });
      checkStopped();
      if (loc.shadowed) log.log(`[code-arc bootstrap] CODE_ARC_BUNDLE (${loc.dir}) shadows the bundle in ${loc.shadowed}`);
      active = { loc, id, manifest };
      set({ source: 'bundle', bundle: bundleSummary(loc, id, manifest) });
    } catch (e) {
      if (e instanceof BundleError) {
        const where = loc ? { location: loc.location, path: loc.dir, shadowed: loc.shadowed } : e.loc || null;
        set({ source: 'bundle', bundle: where ? { ...where, id: null } : null });
      }
      throw e;
    }
  }

  // The bundle's interpreter checks, before the venv is touched.
  async function bundlePython() {
    const { manifest } = active;
    const pipFile = manifest.files.find((f) => f.path === manifest.pip.file);
    if (pipFile.sha256 !== pip.sha256) {
      throw new BundleError('BUNDLE_STALE', `offline bundle ${active.loc.dir}: its pip (${manifest.pip.file}) is not the pip this checkout pins (PIP_PYZ_SHA256)`);
    }
    const preferred = `python${manifest.target.python}`;
    const py = await findPython(run, [preferred, ...PYTHON_CANDIDATES.filter((c) => c !== preferred)], { timeoutMs: timeouts.probe });
    checkStopped();
    const host = await probeTarget(run, py.cmd, timeouts.probe);
    checkStopped();
    checkTarget(manifest.target, host, py.cmd);
    return py;
  }

  async function bootstrap() {
    if (pythonOverride && !bundle) {
      // Ready in the same tick: nothing to verify.
      set({ state: 'ready', phase: null, python: pythonOverride, detail: 'CODE_ARC_PYTHON override', source: 'web' });
      return;
    }
    const reqText = await fs.readFile(path.join(checkoutDir, 'requirements.txt'), 'utf8');
    const reqSha = sha256(reqText);
    await useBundle(reqText);
    if (pythonOverride) {
      set({ state: 'ready', phase: null, python: pythonOverride, detail: 'CODE_ARC_PYTHON override' });
      return;
    }
    set({ state: 'checking', phase: 'stamp' });
    let st = null;
    try {
      st = await fs.lstat(venv);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const stamp = st ? await readStamp() : null;
    if (stamp && stamp.requirements_sha256 === reqSha) {
      set({ state: 'ready', phase: null, python: venvPython, detail: null });
      return;
    }
    if (st && st.isSymbolicLink()) {
      set({ state: 'diverged', phase: 'stamp', code: 'DEPS_DIVERGED', detail: DIVERGED_DETAIL, fix: DIVERGED_FIX });
      return;
    }
    set({ state: 'installing', phase: 'python' });
    const py = active ? await bundlePython() : await findPython(run, PYTHON_CANDIDATES, { timeoutMs: timeouts.probe });
    checkStopped();
    // Re-check right before removing: never follow a link that appeared meanwhile.
    try {
      const again = await fs.lstat(venv);
      if (again.isSymbolicLink()) {
        set({ state: 'diverged', phase: 'stamp', code: 'DEPS_DIVERGED', detail: DIVERGED_DETAIL, fix: DIVERGED_FIX });
        return;
      }
      if (again.isDirectory()) await fs.rm(venv, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await step('venv', py.cmd, ['-m', 'venv', '--without-pip', venv], timeouts.venv, 'VENV_FAILED');
    if (active) {
      // Everything comes from the verified bundle: no download.
      const requirementsFile = path.join(venv, BUNDLE_REQUIREMENTS);
      await fs.writeFile(requirementsFile, hashedRequirements(reqText, active.manifest), { mode: 0o600 });
      const args = bundleInstallArgs({
        pyz: path.join(active.loc.dir, active.manifest.pip.file),
        wheelsDir: path.join(active.loc.dir, 'wheels'),
        requirementsFile,
      });
      await step('install', venvPython, args, timeouts.install, 'INSTALL_FAILED');
    } else {
      set({ phase: 'download' });
      const pyz = path.join(venv, 'pip.pyz');
      await download(pyz);
      await step('install', venvPython, [pyz, 'install', '--disable-pip-version-check', '--no-input', '-r', path.join(checkoutDir, 'requirements.txt')], timeouts.install, 'INSTALL_FAILED');
    }
    await step('smoke', venvPython, ['-I', '-c', 'import arc_agi, arcengine'], timeouts.smoke, 'SMOKE_FAILED');
    checkStopped();
    // Written last: its presence means the venv is complete.
    await fs.writeFile(stampFile, JSON.stringify({ requirements_sha256: reqSha, python_version: py.version }));
    set({ state: 'ready', phase: null, python: venvPython, detail: null, code: null });
  }

  return {
    status: () => ({ ...status }),
    python: () => (status.state === 'ready' ? status.python : null),
    // The verified bundle's games dir once ready, else null (the sidecar's
    // local OFFLINE arcade reads it).
    gamesDir: () => (status.state === 'ready' && status.source === 'bundle' && active ? path.join(active.loc.dir, 'games') : null),
    run() {
      if (!running) {
        running = bootstrap().catch((e) => {
          if (stopped) return;
          const detail = String(e.message || e).slice(-DETAIL_MAX);
          log.error(`[code-arc bootstrap] failed (${e.code || 'ERROR'}): ${detail}`);
          set({ state: 'failed', code: e.code || 'BOOTSTRAP_FAILED', detail, fix: e.fix || FIX });
        });
      }
      return running;
    },
    // Kills any running install step's process group and settles run() as
    // `stopped` (a later start reruns the bootstrap from its stamp check).
    async stop() {
      if (stopped) return running;
      stopped = true;
      abort.abort();
      runner.stopAll();
      if (status.state === 'checking' || status.state === 'installing') {
        set({ state: 'stopped', phase: null, code: null, fix: null, detail: 'bootstrap stopped; it reruns on the next start' });
      }
      return running;
    },
  };
}
