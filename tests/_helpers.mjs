// Shared test fixtures. Each test gets its own temp data dir and projects
// root; apps run the real sidecar on the system python3 against the fake
// toolkit in sidecar/tests/fakes.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKES = path.join(ROOT, 'sidecar', 'tests', 'fakes');

export async function freshEnv(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'code-arc-test-'));
  const dataDir = path.join(tmp, 'data');
  const projectsRoot = path.join(tmp, 'root');
  await fs.mkdir(projectsRoot);
  t?.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return { tmp, dataDir, projectsRoot };
}

// A console stand-in that keeps every line.
export function captureLog() {
  const lines = [];
  const add = (...a) => lines.push(a.map(String).join(' '));
  return { lines, log: add, error: add, warn: add, info: add, text: () => lines.join('\n') };
}

export const config = (env, extra = {}) => ({
  dataDir: env.dataDir, port: 0, checkoutDir: ROOT, python: 'python3', testToolkitDir: FAKES, ...extra,
});

// Starts an app on an ephemeral port; closed after the test.
export async function startApp(t, { env, config: extra, ...opts } = {}) {
  env = env || (await freshEnv(t));
  const log = opts.log || captureLog();
  const app = await createApp({ config: config(env, extra), log, ...opts });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  t.after(close);
  const mcp = (tool, args = {}, caller = { sessionId: 'agent-a', project: 'proj' }) => app.mcp.handle({ tool, arguments: args, caller });
  return { app, url, env, log, mcp, close, calls: () => readCalls(env.dataDir) };
}

export async function readCalls(dataDir) {
  try {
    return (await fs.readFile(path.join(dataDir, 'toolkit', 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export async function startGame(mcp, gameId = 'fake-maze', extra = {}, caller) {
  const r = await mcp('start_session', { game_id: gameId, ...extra }, caller);
  if (!r.meta) throw new Error(`start_session failed: ${JSON.stringify(r)}`);
  return r.meta.session_id;
}

export const json = (url, init = {}) => fetch(url, init).then(async (res) => ({ status: res.status, headers: res.headers, body: await res.json().catch(() => null) }));

export const sendJsonReq = (url, method, body, headers = {}) => json(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Polls `fn` until it returns truthy (short real waits; bounded).
export async function until(fn, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// Reads SSE events from `url` until `stop(events)` is true. `onEvent` runs
// for each event (e.g. to act once the initial state has arrived).
export async function sseCollect(url, stop, { timeoutMs = 3000, onEvent = () => {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(url, { signal: ac.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = { event: 'message', data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) ev.data += line.slice(6);
        }
        if (ev.data) {
          ev.data = JSON.parse(ev.data);
          events.push(ev);
          await onEvent(ev, events);
        }
      }
      if (stop(events)) break;
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return events;
}
