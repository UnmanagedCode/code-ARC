import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { json, ok, refusal, sendJsonReq, startApp, startGame, until } from './_helpers.mjs';

const KEY = 'test-arc-key-0123456789abcdef';

test('the key is stored, masked in the API, and reaches only the sidecar', async (t) => {
  const { url, mcp, log, calls } = await startApp(t);
  assert.deepEqual((await json(`${url}/api/settings`)).body, { apiKey: { set: false, masked: null } });
  const put = await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: KEY });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { apiKey: { set: true, masked: `••••${KEY.slice(-4)}` } });
  assert.deepEqual((await json(`${url}/api/settings`)).body.apiKey, { set: true, masked: `••••${KEY.slice(-4)}` });

  const results = [];
  const record = async (p) => { const r = await p; results.push(JSON.stringify(r)); return r; };
  await record(mcp('list_games'));
  const sid = ok(await record(mcp('start_session', { game_id: 'fake-maze' }))).session_id;
  await record(mcp('act', { session_id: sid, action: 'ACTION1' }));
  await record(mcp('end_session', { session_id: sid }));

  const arcade = (await calls()).filter((c) => c.op === 'Arcade').at(-1);
  assert.equal(arcade.key_sha256, createHash('sha256').update(KEY).digest('hex'));
  assert.deepEqual(arcade.env_arc_vars, [], 'no ARC_* or mode env vars reach the toolkit');
  for (const r of results) assert.ok(!r.includes(KEY), 'key absent from MCP results');
  assert.ok(!log.text().includes(KEY), 'key absent from logs');
});

test('the anonymous key the toolkit logs is redacted in forwarded output', async (t) => {
  const { mcp, log } = await startApp(t);
  await mcp('list_games');
  await until(() => log.lines.some((l) => l.includes('Got anonymous API key')));
  const lines = log.lines.filter((l) => l.includes('Got anonymous API key'));
  for (const l of lines) assert.match(l, /Got anonymous API key: \[redacted\]/);
  assert.ok(!log.text().includes('anon-'));
});

test('key changes are refused while sessions are live', async (t) => {
  const { url, mcp } = await startApp(t);
  const sid = await startGame(mcp);
  const put = await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: KEY });
  assert.equal(put.status, 409);
  assert.equal(put.body.code, 'SESSIONS_ACTIVE');
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'DELETE', {})).status, 409);
  await mcp('end_session', { session_id: sid });
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: KEY })).status, 200);
  const del = await sendJsonReq(`${url}/api/settings/api-key`, 'DELETE', {});
  assert.deepEqual(del.body, { apiKey: { set: false, masked: null } });
});

test('an invalid key is refused without echoing it; short keys are fully masked', async (t) => {
  const { url } = await startApp(t);
  const bad = 'bad key with spaces <script>';
  const r = await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: bad });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_KEY');
  assert.ok(!JSON.stringify(r.body).includes('spaces'));
  const short = await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: 'abcdefgh12' });
  assert.equal(short.body.apiKey.masked, '••••');
});

test('non-GET routes require same-origin JSON', async (t) => {
  const { url } = await startApp(t);
  const plain = await fetch(`${url}/api/settings/api-key`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ key: KEY }) });
  assert.equal(plain.status, 415);
  const cross = await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: KEY }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  const originOnly = await sendJsonReq(`${url}/api/mcp`, 'POST', { tool: 'list_games', arguments: {} }, { origin: 'https://evil.example' });
  assert.equal(originOnly.status, 403);
  const same = await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: KEY }, { 'sec-fetch-site': 'same-origin' });
  assert.equal(same.status, 200);
  assert.equal((await json(`${url}/api/settings`)).body.apiKey.set, true);
});

test('a key change cannot interleave with a start', async (t) => {
  const { app, mcp } = await startApp(t);
  // A start already in flight holds its reservation: the key change is refused,
  // and the session it creates stays playable (its sidecar was not stopped).
  const starting = mcp('start_session', { game_id: 'fake-maze' });
  let applied = false;
  const change = await app.sessions.changeKey(async () => { applied = true; });
  assert.equal(change.code, 'SESSIONS_ACTIVE');
  assert.equal(applied, false);
  const sid = ok(await starting).session_id;
  ok(await mcp('act', { session_id: sid, action: 'ACTION1' }));
  await mcp('end_session', { session_id: sid });

  // A key change in progress blocks starts until it finishes.
  let release;
  const gate = new Promise((r) => { release = r; });
  const changing = app.sessions.changeKey(() => gate);
  const blocked = refusal(await mcp('start_session', { game_id: 'fake-maze' }), 'TOOLKIT_NOT_READY');
  assert.equal(blocked.details.state, 'reconfiguring');
  release();
  assert.deepEqual(await changing, { ok: true });
  ok(await mcp('start_session', { game_id: 'fake-maze' }));
});

test('a refused key or unreachable API is a refusal, not an empty game list', async (t) => {
  const { url, mcp, log } = await startApp(t);
  const bad = 'bad-key-0123456789abcdef';
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: bad })).status, 200);
  const r = refusal(await mcp('list_games'), 'TOOLKIT_ERROR');
  assert.match(r.details.detail, /rejected the API key \(HTTP 401\)/);
  assert.ok(!r.details.detail.includes(bad));
  refusal(await mcp('start_session', { game_id: 'fake-maze' }), 'TOOLKIT_ERROR'); // not GAME_UNKNOWN
  assert.ok(!log.text().includes(bad));

  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: 'offline-0123456789abcdef' })).status, 200);
  refusal(await mcp('list_games'), 'NETWORK_ERROR');
});

test('a second concurrent key change gets KEY_CHANGE_IN_PROGRESS, not the live-sessions message', async (t) => {
  const { app, url } = await startApp(t);
  let release;
  const changing = app.sessions.changeKey(() => new Promise((r) => { release = r; }));
  const r = await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: KEY });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'KEY_CHANGE_IN_PROGRESS');
  assert.match(r.body.error, /another API key change/);
  release();
  await changing;
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: KEY })).status, 200);
});

test('after a key change, starts validate against the new key\'s game list', async (t) => {
  const { url, mcp } = await startApp(t);
  assert.ok(ok(await mcp('list_games')).games.some((g) => g.game_id === 'fake-evil'), 'cached under the old key');
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: 'small-key-0123456789' })).status, 200);
  refusal(await mcp('start_session', { game_id: 'fake-evil' }), 'GAME_UNKNOWN');
  ok(await mcp('start_session', { game_id: 'fake-maze' }));
});
