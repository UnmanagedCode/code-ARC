// Owns the Python sidecar child: lazy spawn, the JSON-lines protocol, a
// deadline on every call, and respawn after exit. The API key reaches the
// child only in the `configure` message on stdin.
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTail } from './proc.js';
import { DETAIL_MAX, SIDECAR_LINE_MAX } from './limits.js';

// The only parent env vars the child sees: no ARC_*, OPERATION_MODE,
// ENVIRONMENTS_DIR or RECORDINGS_DIR, which would override the toolkit's
// constructor arguments.
export const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const READY_TIMEOUT_MS = 30000;
const STDERR_LINE_MAX = 4000;
const ANON_KEY_RE = /(Got anonymous API key: )\S+/g;

// Splits a byte stream into lines without regex; a line longer than `max`
// bytes calls onOverflow instead.
export function createLineSplitter({ max, onLine, onOverflow }) {
  let parts = [];
  let size = 0;
  let overflowed = false;
  return (chunk) => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      size += end - start;
      if (size > max) {
        if (!overflowed) {
          overflowed = true;
          onOverflow();
        }
        parts = [];
      } else if (!overflowed) {
        parts.push(chunk.subarray(start, end));
      }
      if (nl === -1) return;
      if (!overflowed) onLine(Buffer.concat(parts).toString('utf8'));
      parts = [];
      size = 0;
      overflowed = false;
      start = nl + 1;
    }
  };
}

function readPins(checkoutDir) {
  return fs.readFile(path.join(checkoutDir, 'requirements.txt'), 'utf8').then((text) => {
    const pins = {};
    for (const line of text.split('\n')) {
      const [name, ver] = line.trim().split('==');
      if (name === 'arc-agi') pins.arc_agi = ver;
      if (name === 'arcengine') pins.arcengine = ver;
    }
    return pins;
  }).catch(() => ({}));
}

export function createSidecar({
  checkoutDir,
  cwd,
  python, // () => interpreter path or null
  testToolkitDir = null,
  gamesDir = () => null, // the verified bundle's games dir, or null
  getApiKey, // async () => key or null
  spawn = nodeSpawn,
  log = console,
  onExit = () => {},
  onStatus = () => {},
}) {
  const script = path.join(checkoutDir, 'sidecar', 'arc_sidecar.py');
  let child = null;
  let starting = null;
  let versions = null;
  let nextId = 0;
  let configuredKey = null;
  const pending = new Map();
  const tail = createTail(DETAIL_MAX * 4);

  function redact(s) {
    let out = configuredKey ? s.split(configuredKey).join('[redacted]') : s;
    out = out.replace(ANON_KEY_RE, '$1[redacted]');
    return out;
  }

  const recentStderr = () => redact(tail.text()).slice(-DETAIL_MAX);

  function settle(id, reply) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (p.timedOut) p.onLate?.(reply);
    else p.resolve(reply);
  }

  function spawnChild() {
    const env = {};
    for (const k of ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k];
    if (testToolkitDir) env.CODE_ARC_TEST_TOOLKIT_DIR = testToolkitDir;
    const c = spawn(python(), ['-I', '-u', script], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    c.readyResolve = readyResolve;

    c.stdout.on('data', createLineSplitter({
      max: SIDECAR_LINE_MAX,
      onOverflow: () => {
        log.error(`[code-arc] sidecar sent a line over ${SIDECAR_LINE_MAX} bytes; killing it`);
        kill(c);
      },
      onLine: (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          log.error('[code-arc] sidecar sent a malformed protocol line');
          return;
        }
        if (msg && msg.event === 'ready') {
          versions = msg.versions || null;
          readyResolve(true);
          return;
        }
        if (msg && typeof msg.id === 'number') settle(msg.id, msg.ok ? { ok: true, result: msg.result } : { ok: false, code: String(msg.code), detail: String(msg.detail || '') });
      },
    }));
    c.stderr.on('data', createLineSplitter({
      max: SIDECAR_LINE_MAX,
      onOverflow: () => {},
      onLine: (line) => {
        const safe = redact(line.slice(0, STDERR_LINE_MAX));
        tail.push(`${safe}\n`);
        log.log(`[sidecar] ${safe}`);
      },
    }));
    c.stdin.on('error', () => {});
    c.on('error', (e) => {
      log.error(`[code-arc] sidecar spawn failed: ${e.message}`);
      readyResolve(false);
    });
    c.on('exit', (code, signal) => {
      readyResolve(false);
      if (child === c) {
        child = null;
        starting = null;
      }
      const detail = `sidecar exited (${signal || code}). ${recentStderr()}`.trim().slice(0, DETAIL_MAX);
      for (const [id, p] of pending) {
        pending.delete(id);
        clearTimeout(p.timer);
        if (!p.timedOut) p.resolve({ ok: false, code: 'SIDECAR_EXITED', detail });
      }
      if (!c.stopping) log.error(`[code-arc] ${detail}`);
      // A deliberate stop() (key change, shutdown) is not a failure of the
      // live sessions; any other exit is.
      onExit({ code, signal, detail, expected: Boolean(c.stopping) });
      onStatus();
    });
    c.ready = ready;
    return c;
  }

  function kill(c) {
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  }

  function write(c, msg) {
    c.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function rawCall(c, op, args, { timeoutMs, onLate }) {
    return new Promise((resolve) => {
      const id = ++nextId;
      const p = { resolve, onLate, timedOut: false };
      p.timer = setTimeout(() => {
        p.timedOut = true;
        resolve({ ok: false, code: 'TOOLKIT_TIMEOUT', detail: `${op} did not answer within ${timeoutMs} ms` });
        if (!onLate) pending.delete(id);
      }, timeoutMs);
      pending.set(id, p);
      write(c, { id, op, args });
    });
  }

  async function start() {
    const py = python();
    if (!py) return { ok: false, code: 'TOOLKIT_NOT_READY', detail: 'no interpreter yet' };
    const c = spawnChild();
    child = c;
    const timer = setTimeout(() => c.readyResolve(false), READY_TIMEOUT_MS);
    const ok = await c.ready;
    clearTimeout(timer);
    if (!ok) {
      kill(c);
      return { ok: false, code: 'SIDECAR_EXITED', detail: `sidecar did not start. ${recentStderr()}`.slice(0, DETAIL_MAX) };
    }
    const pins = await readPins(checkoutDir);
    for (const k of Object.keys(pins)) {
      if (versions && versions[k] !== pins[k]) log.error(`[code-arc] warning: sidecar reports ${k} ${versions[k]}, requirements.txt pins ${pins[k]}`);
    }
    let key = null;
    try {
      key = await getApiKey();
    } catch (e) {
      kill(c);
      return { ok: false, code: 'TOOLKIT_ERROR', detail: e.message };
    }
    configuredKey = key;
    const r = await rawCall(c, 'configure', { api_key: key, games_dir: gamesDir() }, { timeoutMs: READY_TIMEOUT_MS });
    if (!r.ok) {
      kill(c);
      return r;
    }
    onStatus();
    return { ok: true, child: c };
  }

  return {
    // Resolves {ok:true, result} or {ok:false, code, detail}; never rejects.
    // After a timeout the eventual reply goes to onLate.
    async call(op, args, { timeoutMs, onLate } = {}) {
      if (!child) starting = null;
      if (!starting) starting = start();
      const s = await starting;
      if (!s.ok) {
        starting = null;
        return s;
      }
      if (s.child !== child) return { ok: false, code: 'SIDECAR_EXITED', detail: 'sidecar restarted' };
      return rawCall(s.child, op, args, { timeoutMs, onLate });
    },
    status: () => ({ running: Boolean(child), versions }),
    // Kills the child; the next call respawns it (and re-sends configure).
    stop() {
      const c = child;
      child = null;
      starting = null;
      if (c) c.stopping = true;
      kill(c);
    },
    pid: () => child?.pid ?? null,
  };
}
