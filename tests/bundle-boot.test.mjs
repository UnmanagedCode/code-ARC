// A whole backend booted with an offline bundle: the real sidecar on the
// fake toolkit, whose network can be switched off (netDown). The fake logs
// every request it would send to <data>/toolkit/net.jsonl; the backend's own
// fetch is a spy that refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { verifyBundle } from '../src/bundle.js';
import { freshEnv, json, readCalls, startApp, startGame, until } from './_helpers.mjs';
import { fetchSpy, makeBundleDir, netDown, readNet, ROOT_REQS, snapshot } from './_bundle.mjs';

const locations = (env, envPath = null) => ({
  envPath, dataDirPath: path.join(env.dataDir, 'bundle'), toolkitDir: path.join(env.dataDir, 'toolkit'),
});

// Boots with a bundle in the data-dir slot (`games` in it) and waits for ready.
async function bootBundled(t, { games = ['fake-maze', 'fake-evil'], down = false, envBundle = null, env: given } = {}) {
  const env = given || await freshEnv(t);
  const slot = await makeBundleDir(path.join(env.dataDir, 'bundle'), { games });
  if (down) await netDown(env.dataDir);
  const spy = fetchSpy();
  const app = await startApp(t, { env, config: { bundle: locations(env, envBundle) }, fetch: spy.fetch });
  const tk = await until(async () => {
    const s = (await json(`${app.url}/api/status`)).body.toolkit;
    return s.state !== 'checking' && s;
  });
  return { ...app, slot, spy, tk };
}

test('bundle + unreachable network: list, start, act, end work locally', async (t) => {
  const a = await bootBundled(t, { down: true });
  assert.equal(a.tk.state, 'ready');
  assert.equal(a.tk.source, 'bundle');
  assert.equal(a.tk.bundle.id, a.slot.id);
  assert.equal(a.tk.bundle.location, 'data_dir');

  const list = (await a.mcp('list_games')).result;
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.deepEqual(list.games.map((g) => [g.game_id, g.source, g.downloaded]).sort(), [['fake-evil', 'bundle', true], ['fake-maze', 'bundle', true]]);
  const netAfterList = await readNet(a.env.dataDir);
  assert.ok(netAfterList.length > 0, 'the web list was attempted');
  assert.ok(netAfterList.every((n) => n.ok === false), 'and every attempt failed');

  const id = await startGame(a.mcp, 'fake-maze');
  const act = (await a.mcp('act', { session_id: id, action: 'ACTION4' })).meta;
  assert.equal(act.ok, true);
  const end = (await a.mcp('end_session', { session_id: id })).result;
  assert.equal(end.ok, true, JSON.stringify(end));

  assert.deepEqual(a.spy.calls, [], 'the backend fetched nothing');
  assert.deepEqual(await readNet(a.env.dataDir), netAfterList, 'local play sent no request');
  const calls = await readCalls(a.env.dataDir);
  const offline = calls.filter((c) => c.op === 'Arcade' && c.mode === 'offline');
  assert.deepEqual(offline.map((c) => c.environments_dir), [path.join(a.env.dataDir, 'bundle', 'games')]);
  assert.ok(calls.some((c) => c.op === 'load_source' && c.game_id === 'fake-maze'), 'the bundled source was loaded');
});

test('no bundle + unreachable network: list_games is refused with NETWORK_ERROR (control)', async (t) => {
  const env = await freshEnv(t);
  await netDown(env.dataDir);
  const spy = fetchSpy();
  const a = await startApp(t, { env, config: { bundle: locations(env) }, fetch: spy.fetch });
  await until(async () => (await json(`${a.url}/api/status`)).body.toolkit.state === 'ready');
  const list = (await a.mcp('list_games')).result;
  assert.equal(list.code, 'NETWORK_ERROR', JSON.stringify(list));
  assert.equal((await json(`${a.url}/api/status`)).body.toolkit.source, 'web');
  assert.ok((await readNet(env.dataDir)).every((n) => n.ok === false));
});

test('bundle + network: list_games adds web games after the bundle\'s', async (t) => {
  const a = await bootBundled(t, { games: ['fake-maze'] });
  const list = (await a.mcp('list_games')).result;
  const ids = list.games.map((g) => g.game_id);
  assert.deepEqual(list.games[0], { game_id: 'fake-maze', title: 'Fake Maze', tags: [], downloaded: true, source: 'bundle' });
  assert.ok(list.games.slice(1).length > 0 && list.games.slice(1).every((g) => g.source === 'web'));
  assert.ok(ids.includes('fake-evil'));
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
});

test('online:true with a bundle and network goes online as today', async (t) => {
  const a = await bootBundled(t);
  const r = await a.mcp('start_session', { game_id: 'fake-maze', online: true });
  assert.equal(r.meta?.mode, 'online', JSON.stringify(r));
  assert.ok(r.meta.online.scorecard_url);
  assert.ok((await readNet(a.env.dataDir)).some((n) => n.mode === 'online' && n.ok === true));
});

test('online:true with a bundle and no network fails with NETWORK_ERROR', async (t) => {
  const a = await bootBundled(t, { down: true });
  const r = (await a.mcp('start_session', { game_id: 'fake-maze', online: true })).result;
  assert.equal(r.code, 'NETWORK_ERROR', JSON.stringify(r));
  assert.ok(r.detail);
  assert.deepEqual((await a.mcp('list_sessions', { scope: 'all' })).result.sessions, [], 'no session stored');
});

test('online:true for a game outside the bundle with no network fails with NETWORK_ERROR', async (t) => {
  const a = await bootBundled(t, { games: ['fake-maze'], down: true });
  const r = (await a.mcp('start_session', { game_id: 'fake-evil', online: true })).result;
  assert.equal(r.code, 'NETWORK_ERROR', JSON.stringify(r));
  assert.match(r.detail, /web game list could not be fetched \(NETWORK_ERROR\)/);
  assert.deepEqual((await a.mcp('list_sessions', { scope: 'all' })).result.sessions, []);
});

test('a local game outside the bundle with no network is GAME_UNKNOWN, naming the unavailable web list', async (t) => {
  const a = await bootBundled(t, { games: ['fake-maze'], down: true });
  const r = (await a.mcp('start_session', { game_id: 'fake-evil' })).result;
  assert.equal(r.code, 'GAME_UNKNOWN', JSON.stringify(r));
  assert.match(r.detail, /not in the offline bundle and the web game list could not be fetched/);
  // An id that is in neither list stays a plain GAME_UNKNOWN when the web list loads.
  const up = await bootBundled(t, { games: ['fake-maze'] });
  const plain = (await up.mcp('start_session', { game_id: 'nope-game' })).result;
  assert.equal(plain.code, 'GAME_UNKNOWN');
  assert.equal(plain.detail, undefined);
});

test('a local game outside the bundle downloads into toolkit/, never into the bundle', async (t) => {
  const a = await bootBundled(t, { games: ['fake-maze'] });
  const before = await snapshot(a.slot.dir);
  const id = await startGame(a.mcp, 'fake-evil');
  assert.equal((await a.mcp('act', { session_id: id, action: 'ACTION4' })).meta.ok, true);
  const dl = path.join(a.env.dataDir, 'toolkit', 'environment_files', 'fake', 'evil');
  assert.deepEqual((await fs.readdir(dl)).sort(), ['fake.py', 'metadata.json']);
  assert.deepEqual(await snapshot(a.slot.dir), before, 'the bundle is untouched');
  await verifyBundle(a.slot.dir, { requirementsText: ROOT_REQS });
});

test('CODE_ARC_BUNDLE wins over the data-dir bundle and reports it shadowed', async (t) => {
  const env = await freshEnv(t);
  const other = await makeBundleDir(path.join(env.tmp, 'elsewhere'), { games: ['fake-evil'] });
  const a = await bootBundled(t, { env, games: ['fake-maze'], envBundle: other.dir });
  assert.equal(a.tk.state, 'ready');
  assert.equal(a.tk.bundle.location, 'env');
  assert.equal(a.tk.bundle.id, other.id);
  assert.equal(a.tk.bundle.shadowed, path.join(env.dataDir, 'bundle'));
  assert.ok(a.log.lines.some((l) => /shadows the bundle/.test(l)));
  const list = (await a.mcp('list_games')).result;
  assert.deepEqual(list.games.filter((g) => g.source === 'bundle').map((g) => g.game_id), ['fake-evil']);
});

test('an invalid winning bundle is a failed state with no fallback', async (t) => {
  const env = await freshEnv(t);
  const bad = await makeBundleDir(path.join(env.tmp, 'tampered'));
  await fs.appendFile(path.join(bad.dir, 'games', 'fake', 'maze', 'fake.py'), 'import os  # tampered\n');
  const a = await bootBundled(t, { env, envBundle: bad.dir });
  assert.equal(a.tk.state, 'failed');
  assert.equal(a.tk.code, 'BUNDLE_HASH_MISMATCH');
  assert.equal(a.tk.source, 'bundle');
  assert.deepEqual([a.tk.bundle.location, a.tk.bundle.id], ['env', null]);
  assert.match(a.tk.fix, /re-import/);
  const r = (await a.mcp('start_session', { game_id: 'fake-maze' })).result;
  assert.equal(r.code, 'TOOLKIT_UNAVAILABLE');
  assert.match(r.detail, /games\/fake\/maze\/fake\.py is \d+ bytes, the manifest says/);
  assert.ok(r.fix);
  assert.deepEqual(await readCalls(env.dataDir), [], 'the toolkit never ran');
  assert.deepEqual(a.spy.calls, []);
});
