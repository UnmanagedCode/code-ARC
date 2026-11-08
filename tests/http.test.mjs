import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshEnv, json, ROOT, sendJsonReq, sseCollect, startApp, startGame } from './_helpers.mjs';
import { createRouter, onClientError, SECURITY_HEADERS } from '../src/http.js';
import { SESSIONS_PAGE_MAX, SSE_MAX_BUFFERED_BYTES, STEPS_PAGE_MAX } from '../src/limits.js';

const FRONTEND = path.join(ROOT, 'frontend');

function assertSecurityHeaders(headers, what) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(headers.get(k), v, `${what}: ${k}`);
}

test('security headers on 200, 404, 405 and 415 responses', async (t) => {
  const { url } = await startApp(t);
  assertSecurityHeaders((await fetch(`${url}/api/health`)).headers, '200');
  assertSecurityHeaders((await fetch(`${url}/nope`)).headers, '404');
  assertSecurityHeaders((await fetch(`${url}/api/health`, { method: 'POST', headers: { 'content-type': 'application/json' } })).headers, '405');
  assertSecurityHeaders((await fetch(`${url}/api/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).headers, '415');
  assert.match(SECURITY_HEADERS['content-security-policy'], /frame-ancestors 'self'/);
});

test('a throwing handler answers 500 with the security headers', async (t) => {
  const log = { error() {} };
  const server = http.createServer(createRouter({ routes: [['GET', '/boom', () => { throw new Error('boom'); }]], fallback: () => {}, log }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/boom`);
  assert.equal(res.status, 500);
  assertSecurityHeaders(res.headers, '500');
  assert.deepEqual(await res.json(), { error: 'internal error', code: 'INTERNAL' });
});

test('many keep-alive requests on one socket add one error listener, not one each', async (t) => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const server = http.createServer(createRouter({ routes: [['GET', '/ok', (req, res) => res.end('ok')]], fallback: () => {}, log: { error() {} } }));
  const sockets = [];
  server.on('connection', (s) => sockets.push(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => { agent.destroy(); return new Promise((r) => server.close(r)); });
  const get = () => new Promise((resolve, reject) => {
    http.get({ port: server.address().port, host: '127.0.0.1', path: '/ok', agent }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  await get();
  const afterOne = sockets[0].listenerCount('error');
  for (let i = 0; i < 40; i++) await get();
  assert.equal(sockets.length, 1, 'all requests shared one keep-alive socket');
  assert.equal(sockets[0].listenerCount('error'), afterOne);
  await new Promise((r) => setImmediate(r));
  assert.ok(!warnings.includes('MaxListenersExceededWarning'));
});

test('a malformed request gets 400 with the security headers', async (t) => {
  const server = http.createServer(() => {});
  server.on('clientError', onClientError);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const raw = await new Promise((resolve, reject) => {
    const s = net.connect(server.address().port, '127.0.0.1', () => s.write('GARBAGE\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  assert.match(raw, /content-security-policy: default-src 'none'/);
  assert.match(raw, /x-content-type-options: nosniff/);
});

test('static: allowlisted files only; host URLs and sources 404', async (t) => {
  const { url } = await startApp(t);
  const files = (await fs.readdir(FRONTEND)).filter((f) => /\.(html|css|js)$/.test(f));
  for (const f of files) {
    const res = await fetch(`${url}/${f}`);
    assert.equal(res.status, 200, f);
    assert.match(res.headers.get('content-type'), f.endsWith('.js') ? /^text\/javascript/ : f.endsWith('.css') ? /^text\/css/ : /^text\/html/);
  }
  assert.equal((await fetch(`${url}/`)).status, 200);
  for (const p of ['/pluginBridge.js', '/pluginTheme.css', '/package.json', '/src/app.js', '/app.js.map', '/frontend/app.js', '/%2e%2e/package.json']) {
    assert.equal((await fetch(`${url}${p}`)).status, 404, p);
  }
});

test('index.html: title and heading, and only relative URLs besides the two host URLs', async () => {
  const html = await fs.readFile(path.join(FRONTEND, 'index.html'), 'utf8');
  assert.match(html, /<title>Code ARC<\/title>/);
  assert.match(html, /<h1[^>]*>Code ARC<\/h1>/);
  const urls = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(urls.length > 0);
  const HOST = new Set(['/pluginBridge.js', '/pluginTheme.css']);
  for (const u of urls) {
    if (HOST.has(u)) continue;
    assert.ok(!u.startsWith('/') && !/^[a-z]+:/i.test(u), `non-relative URL ${u}`);
  }
  assert.match(html, /<head>\s*<meta charset="utf-8">\s*<script src="\/pluginBridge\.js"><\/script>/, 'the bridge is the first script, blocking');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
  assert.doesNotMatch(html, /\sstyle=|<style/, 'no inline styles');
});

test('frontend code never builds DOM from strings or evaluates code', async () => {
  const banned = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\b/];
  for (const f of (await fs.readdir(FRONTEND)).filter((n) => n.endsWith('.js'))) {
    const src = await fs.readFile(path.join(FRONTEND, f), 'utf8');
    for (const re of banned) assert.doesNotMatch(src, re, `${f}: ${re}`);
    assert.doesNotMatch(src, /fetch\(\s*['"`]\//, `${f}: root-relative fetch`);
    assert.doesNotMatch(src, /location\.hash\s*=/, `${f}: hash navigation`);
  }
});

test('an act publishes a step event over SSE', async (t) => {
  const { url, mcp } = await startApp(t);
  const sid = await startGame(mcp);
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'step'), {
    onEvent: async (ev) => { if (ev.event === 'sessions') await mcp('act', { session_id: sid, action: 'ACTION4', reasoning: 'live' }); },
  });
  assert.equal(events[0].event, 'status');
  const step = events.find((e) => e.event === 'step').data;
  assert.equal(step.session_id, sid);
  assert.equal(step.step.n, 1);
  assert.equal(step.step.reasoning, 'live');
  assert.equal(step.step.frame.length, 64);
});

test('session routes: list, get, paged steps bounded by STEPS_PAGE_MAX', async (t) => {
  // Back-to-back acts; the per-session step rate is not under test here.
  const { url, mcp } = await startApp(t, { stepRate: { max: 1000, windowMs: 1000 } });
  const sid = await startGame(mcp);
  for (let i = 0; i < STEPS_PAGE_MAX + 2; i++) await mcp('act', { session_id: sid, action: 'ACTION6', x: i % 64, y: 1, frame: 'none' });
  assert.equal((await json(`${url}/api/sessions`)).body.sessions[0].id, sid);
  assert.equal((await json(`${url}/api/sessions/${sid}`)).body.step_count, STEPS_PAGE_MAX + 2);
  const big = (await json(`${url}/api/sessions/${sid}/steps?limit=100000`)).body.steps;
  assert.equal(big.length, STEPS_PAGE_MAX);
  assert.equal(big[0].n, 0);
  const page = (await json(`${url}/api/sessions/${sid}/steps?from=150&limit=3`)).body.steps;
  assert.deepEqual(page.map((s) => s.n), [150, 151, 152]);
  assert.equal((await json(`${url}/api/sessions/s-000000000000`)).status, 404);
  assert.equal((await json(`${url}/api/sessions/..%2Fsecrets`)).status, 404);
  assert.equal((await sendJsonReq(`${url}/api/sessions`, 'POST', {})).status, 405);
});

// Pins the contract Replay relies on: an ended session's steps stay readable.
test("an ended session's steps stay readable for replay", async (t) => {
  const { url, mcp } = await startApp(t, { stepRate: { max: 1000, windowMs: 1000 } });
  const sid = await startGame(mcp);
  for (let i = 0; i < 3; i++) await mcp('act', { session_id: sid, action: 'ACTION6', x: i, y: 1 });
  await mcp('end_session', { session_id: sid });
  assert.notEqual((await json(`${url}/api/sessions/${sid}`)).body.status, 'live');
  const steps = (await json(`${url}/api/sessions/${sid}/steps`)).body.steps;
  assert.deepEqual(steps.map((x) => x.n), [0, 1, 2, 3]);
  assert.ok(steps.every((x) => x.frame.length === 64));
});

test('status reports the toolkit and sidecar', async (t) => {
  const { url, mcp } = await startApp(t);
  await mcp('list_games');
  const s = (await json(`${url}/api/status`)).body;
  assert.equal(s.toolkit.state, 'ready');
  assert.equal(s.sidecar.running, true);
  assert.deepEqual(s.sidecar.versions, { arc_agi: '0.9.9', arcengine: '0.9.3' });
});

// Writes `n` ended sessions straight into a data dir, as a long-used install has.
async function seedSessions(dataDir, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `s-${i.toString(16).padStart(12, '0')}`;
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const meta = {
      id, game_id: 'fake-maze', title: `Old game ${i} ${'·'.repeat(200)}`, mode: 'local',
      owner: { sessionId: 'agent-old', project: 'proj' }, scorecard_id: 'c', scorecard_url: null,
      status: 'ended', end_reason: 'ended_by_agent', stalled: false, created_at: t, updated_at: t, last_activity_at: t,
      step_count: 0, last: { state: 'NOT_FINISHED', levels_completed: 0, win_levels: 2, available_actions: [1], frame_count: 1, full_reset: true },
    };
    await fs.mkdir(path.join(dataDir, 'sessions', id), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'sessions', id, 'meta.json'), JSON.stringify(meta));
    ids.push(id);
  }
  return ids;
}

test('with thousands of stored sessions the viewer stream stays up and pages through them all', async (t) => {
  const env = await freshEnv(t);
  const n = 1200;
  const ids = await seedSessions(env.dataDir, n);
  const { url, mcp, app } = await startApp(t, { env });
  assert.ok(Buffer.byteLength(JSON.stringify(app.store.list())) > SSE_MAX_BUFFERED_BYTES, 'all sessions together exceed the backlog cap');

  let sid = null;
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'step'), {
    onEvent: async (ev) => { if (ev.event === 'sessions') sid = await startGame(mcp); },
  });
  const initial = events.find((e) => e.event === 'sessions').data;
  assert.equal(initial.sessions.length, SESSIONS_PAGE_MAX);
  assert.equal(initial.total, n);
  assert.equal(initial.sessions[0].id, ids.at(-1), 'newest first');
  assert.ok(initial.next);
  assert.ok(events.some((e) => e.event === 'session' && e.data.id === sid), 'live events still arrive');

  const seen = [];
  let page = (await json(`${url}/api/sessions`)).body;
  for (;;) {
    seen.push(...page.sessions.map((s) => s.id));
    assert.ok(page.sessions.length <= SESSIONS_PAGE_MAX);
    if (!page.next) break;
    page = (await json(`${url}/api/sessions?before=${page.next}`)).body;
  }
  assert.equal(seen.length, n + 1);
  assert.equal(new Set(seen).size, n + 1, 'no duplicates across pages');
  assert.equal(seen[0], sid);
  assert.equal((await json(`${url}/api/sessions?before=nope`)).status, 400);
});

test('frames route: every stored frame of a step with its toolkit index; unknown step is STEP_UNKNOWN', async (t) => {
  const { url, mcp } = await startApp(t, { stepRate: { max: 1000, windowMs: 1000 } });
  const maze = await startGame(mcp);
  await mcp('act', { session_id: maze, action: 'ACTION4' });
  const two = (await json(`${url}/api/sessions/${maze}/steps/1/frames`)).body;
  assert.deepEqual([two.n, two.frame_count, two.stored, two.omitted], [1, 2, 2, 0]);
  assert.deepEqual(two.frames.map((f) => f.index), [0, 1]);
  assert.ok(two.frames.every((f) => f.rows.length === 64));
  const start = (await json(`${url}/api/sessions/${maze}/steps/0/frames`)).body;
  assert.deepEqual(start.frames.map((f) => f.index), [0]);

  const long = await startGame(mcp, 'fake-anim');
  await mcp('act', { session_id: long, action: 'ACTION1' });
  const gap = (await json(`${url}/api/sessions/${long}/steps/1/frames`)).body;
  assert.deepEqual([gap.frame_count, gap.stored, gap.omitted, gap.frames.length], [70, 64, 6, 64]);
  assert.equal(gap.frames.at(-1).index, 69);

  const missing = await json(`${url}/api/sessions/${maze}/steps/9/frames`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'STEP_UNKNOWN');
  assert.equal((await json(`${url}/api/sessions/s-000000000000/steps/0/frames`)).body.code, 'SESSION_UNKNOWN');
});

test('step pages and the SSE step event carry the last frame only, never the animation', async (t) => {
  const { url, mcp } = await startApp(t, { stepRate: { max: 1000, windowMs: 1000 } });
  const sid = await startGame(mcp);
  const events = await sseCollect(`${url}/api/events`, (evs) => evs.some((e) => e.event === 'step'), {
    onEvent: async (ev) => { if (ev.event === 'sessions') await mcp('act', { session_id: sid, action: 'ACTION4' }); },
  });
  const step = events.find((e) => e.event === 'step').data.step;
  assert.equal(step.frame_count, 2);
  assert.ok(!('anim' in step) && !('anim_z' in step));
  const page = (await json(`${url}/api/sessions/${sid}/steps`)).body.steps;
  assert.ok(page.every((s) => !('anim' in s) && !('anim_z' in s)));
  assert.equal(page[1].frame.length, 64);
});
