// Builds the Python venv the sidecar runs in, asynchronously, so health and
// the UI answer the whole time. State: checking → installing → ready, or
// failed / diverged. Never throws: a failure is a state.
//
// The venv lives at <checkout>/.venv; worktrees may share the main checkout's
// through a symlink, which is never written through (see the deps rule in
// docs/architecture.md).
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DETAIL_MAX } from './limits.js';

export const PIP_VERSION = '26.3';
export const PIP_PYZ_URL = `https://bootstrap.pypa.io/pip/zipapp/pip-${PIP_VERSION}.pyz`;
export const PIP_PYZ_SHA256 = 'be510f6d23d345eeabdd3eec2599a3ca2df3cbc98c4afbe2631561ca12e744d7';
const PIP_PYZ_MAX_BYTES = 20 * 1024 * 1024;
const MIN_PYTHON = [3, 12];
const PYTHON_CANDIDATES = ['python3.13', 'python3.12', 'python3'];
const TAIL_CHARS = 4000;

export const DEFAULT_TIMEOUTS = Object.freeze({ probe: 10000, venv: 120000, download: 60000, install: 600000, smoke: 60000 });

export const FIX = 'see the detail; then restart the plugin, or run `node scripts/setup.mjs` in the plugin checkout';
export const DIVERGED_DETAIL = "this worktree's requirements.txt differs from the shared venv; run `rm .venv` (removes only this worktree's symlink) then restart the plugin, or `node scripts/setup.mjs`";

class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Keeps the last `max` characters of a stream as a list of chunks.
export function createTail(max = TAIL_CHARS) {
  const chunks = [];
  let size = 0;
  return {
    push(s) {
      chunks.push(s);
      size += s.length;
      while (size - chunks[0].length >= max) size -= chunks.shift().length;
    },
    text: () => chunks.join('').slice(-max),
  };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function createBootstrap({
  checkoutDir,
  pythonOverride = null,
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
  let status = { state: 'checking', phase: 'stamp', detail: null, python: null, code: null };
  let running = null;

  function set(next) {
    status = { ...status, ...next };
    onChange(status);
  }

  // Runs a command to completion with a deadline; on timeout kills its process group.
  function run(cmd, args, { timeoutMs, stream = false, cwd = checkoutDir } = {}) {
    return new Promise((resolve) => {
      const tail = createTail();
      let child;
      try {
        child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ code: null, error: e, tail: '' });
        return;
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, timeoutMs);
      timer.unref?.();
      const onData = (d) => {
        const s = d.toString();
        tail.push(s);
        if (stream) for (const line of s.split('\n')) if (line) log.log(`[code-arc bootstrap] ${line}`);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, error: e, tail: tail.text() });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut, tail: tail.text() });
      });
    });
  }

  async function readStamp() {
    try {
      return JSON.parse(await fs.readFile(stampFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function findPython() {
    for (const cand of PYTHON_CANDIDATES) {
      const r = await run(cand, ['--version'], { timeoutMs: timeouts.probe });
      const m = r.code === 0 && /Python (\d+)\.(\d+)\.(\d+)/.exec(r.tail);
      if (!m) continue;
      const [maj, min] = [Number(m[1]), Number(m[2])];
      if (maj > MIN_PYTHON[0] || (maj === MIN_PYTHON[0] && min >= MIN_PYTHON[1])) return { cmd: cand, version: `${m[1]}.${m[2]}.${m[3]}` };
    }
    throw new BootstrapError('PYTHON_MISSING', `no Python >= ${MIN_PYTHON.join('.')} found (tried ${PYTHON_CANDIDATES.join(', ')}); install one and restart the plugin`);
  }

  async function download(dest) {
    let res;
    try {
      res = await fetch(pip.url, { signal: AbortSignal.timeout(timeouts.download) });
    } catch (e) {
      throw new BootstrapError('DOWNLOAD_FAILED', `could not fetch ${pip.url}: ${e.message}`);
    }
    if (!res.ok) throw new BootstrapError('DOWNLOAD_FAILED', `${pip.url} answered ${res.status}`);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > PIP_PYZ_MAX_BYTES) throw new BootstrapError('DOWNLOAD_FAILED', `${pip.url} is over ${PIP_PYZ_MAX_BYTES} bytes`);
        chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      if (e instanceof BootstrapError) throw e;
      throw new BootstrapError('DOWNLOAD_FAILED', `reading ${pip.url} failed: ${e.message}`);
    }
    const buf = Buffer.concat(chunks);
    const got = sha256(buf);
    if (got !== pip.sha256) throw new BootstrapError('HASH_MISMATCH', `${pip.url} has sha256 ${got}, expected ${pip.sha256}`);
    await fs.writeFile(dest, buf, { mode: 0o600 });
  }

  async function step(phase, cmd, args, timeoutMs, code) {
    set({ state: 'installing', phase });
    const r = await run(cmd, args, { timeoutMs, stream: true });
    if (r.code !== 0) {
      const why = r.timedOut ? `timed out after ${timeoutMs} ms` : r.error ? r.error.message : `exited ${r.code}`;
      throw new BootstrapError(code, `${phase} ${why}: ${r.tail.slice(-DETAIL_MAX)}`);
    }
  }

  async function bootstrap() {
    if (pythonOverride) {
      set({ state: 'ready', phase: null, python: pythonOverride, detail: 'CODE_ARC_PYTHON override' });
      return;
    }
    const reqSha = sha256(await fs.readFile(path.join(checkoutDir, 'requirements.txt')));
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
      set({ state: 'diverged', phase: 'stamp', code: 'DEPS_DIVERGED', detail: DIVERGED_DETAIL });
      return;
    }
    set({ state: 'installing', phase: 'python' });
    const py = await findPython();
    // Re-check right before removing: never follow a link that appeared meanwhile.
    try {
      const again = await fs.lstat(venv);
      if (again.isSymbolicLink()) {
        set({ state: 'diverged', phase: 'stamp', code: 'DEPS_DIVERGED', detail: DIVERGED_DETAIL });
        return;
      }
      if (again.isDirectory()) await fs.rm(venv, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await step('venv', py.cmd, ['-m', 'venv', '--without-pip', venv], timeouts.venv, 'VENV_FAILED');
    set({ phase: 'download' });
    const pyz = path.join(venv, 'pip.pyz');
    await download(pyz);
    await step('install', venvPython, [pyz, 'install', '--disable-pip-version-check', '--no-input', '-r', path.join(checkoutDir, 'requirements.txt')], timeouts.install, 'INSTALL_FAILED');
    await step('smoke', venvPython, ['-I', '-c', 'import arc_agi, arcengine'], timeouts.smoke, 'SMOKE_FAILED');
    // Written last: its presence means the venv is complete.
    await fs.writeFile(stampFile, JSON.stringify({ requirements_sha256: reqSha, python_version: py.version }));
    set({ state: 'ready', phase: null, python: venvPython, detail: null, code: null });
  }

  return {
    status: () => ({ ...status }),
    python: () => (status.state === 'ready' ? status.python : null),
    run() {
      if (!running) {
        running = bootstrap().catch((e) => {
          const detail = String(e.message || e).slice(-DETAIL_MAX);
          log.error(`[code-arc bootstrap] failed (${e.code || 'ERROR'}): ${detail}`);
          set({ state: 'failed', code: e.code || 'BOOTSTRAP_FAILED', detail });
        });
      }
      return running;
    },
  };
}
