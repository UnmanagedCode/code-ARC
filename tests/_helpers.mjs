// Shared test fixtures. Each test gets its own temp data dir and projects
// root; apps run the real sidecar on the system python3 against the fake
// toolkit in sidecar/tests/fakes.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import manifest from '../conductor.plugin.json' with { type: 'json' };
import { validate } from './_jsonSchemaSubset.mjs';

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
  const call = (format) => async (tool, args = {}, caller = { sessionId: 'agent-a', project: 'proj' }) => {
    const r = await app.mcp.handle({ tool, arguments: args, caller, format });
    TOOL_OF.set(r, tool);
    return r;
  };
  // `mcp` asks for the json view and returns the raw reply: unwrap it with ok()
  // or refusal(). `mcpText` asks for the text view.
  const mcp = call('json');
  const mcpText = call('text');
  return { app, url, env, log, mcp, mcpText, close, calls: () => readCalls(env.dataDir) };
}

export async function readCalls(dataDir) {
  try {
    return (await fs.readFile(path.join(dataDir, 'toolkit', 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// Which tool produced a reply from startApp's mcp helpers, for ok().
const TOOL_OF = new WeakMap();
const OUTPUT_SCHEMAS = Object.fromEntries(manifest.mcp.tools.map((t) => [t.name, t.outputSchema]));

// A json success reply: exactly {structured}, valid against the tool's manifest
// outputSchema (the check cc applies). Returns the structured data. A reply
// from a direct app.mcp.handle call needs the tool name: ok(r, tool).
export function ok(r, tool = TOOL_OF.get(r)) {
  assert.deepEqual(Object.keys(r), ['structured'], `not a json success: ${JSON.stringify(r)}`);
  const errors = validate(OUTPUT_SCHEMAS[tool], r.structured);
  assert.deepEqual(errors, [], `${tool} reply breaks its outputSchema`);
  return r.structured;
}

// A refusal reply: {error, code, details?} and nothing else, with `code`.
// Returns it (extras under .details).
export function refusal(r, code) {
  assert.ok(Object.keys(r).every((k) => ['error', 'code', 'details'].includes(k)), `not a refusal shape: ${JSON.stringify(r)}`);
  assert.equal(typeof r.error, 'string');
  assert.equal(r.code, code, JSON.stringify(r));
  if ('details' in r) assert.ok(r.details && typeof r.details === 'object' && Object.keys(r.details).length > 0);
  return r;
}

export async function startGame(mcp, gameId = 'fake-maze', extra = {}, caller) {
  const r = await mcp('start_session', { game_id: gameId, ...extra }, caller);
  if (!r.structured) throw new Error(`start_session failed: ${JSON.stringify(r)}`);
  return r.structured.session_id;
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
