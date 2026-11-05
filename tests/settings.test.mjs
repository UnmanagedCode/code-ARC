import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { json, sendJsonReq, startApp, startGame, until } from './_helpers.mjs';

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
  const sid = (await record(mcp('start_session', { game_id: 'fake-maze' }))).meta.session_id;
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
