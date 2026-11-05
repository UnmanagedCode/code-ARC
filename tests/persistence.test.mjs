import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshEnv, json, sendJsonReq, startApp, startGame } from './_helpers.mjs';

test('sessions and steps survive a restart; live sessions end as backend_restart', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const sid = await startGame(first.mcp);
  await first.mcp('act', { session_id: sid, action: 'ACTION4', reasoning: 'right' });
  const paint = await first.mcp('act', { session_id: sid, action: 'ACTION6', x: 7, y: 9, frame: 'full' });
  const done = await startGame(first.mcp);
  await first.mcp('end_session', { session_id: done });
  await first.close();

  const second = await startApp(t, { env });
  const meta = second.app.store.get(sid);
  assert.equal(meta.status, 'ended');
  assert.equal(meta.end_reason, 'backend_restart');
  assert.equal(second.app.store.get(done).end_reason, 'ended_by_agent');
  const obs = await second.mcp('observe', { session_id: sid });
  assert.equal(obs.meta.step, 2);
  assert.equal(obs.text[0], paint.text[0], 'observe rebuilds the last frame from steps.jsonl');
  const steps = (await json(`${second.url}/api/sessions/${sid}/steps`)).body.steps;
  assert.deepEqual(steps.map((s) => s.action), ['START', 'ACTION4', 'ACTION6']);
  assert.equal(steps[1].reasoning, 'right');
  assert.deepEqual([steps[2].x, steps[2].y], [7, 9]);
  assert.equal((await second.mcp('act', { session_id: sid, action: 'ACTION1' })).result.code, 'SESSION_ENDED');
});

test('state stays in the data dir with private modes; the projects root is untouched', async (t) => {
  const env = await freshEnv(t);
  const { mcp, url } = await startApp(t, { env });
  await startGame(mcp);
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: 'abcdefgh-1234' })).status, 409);
  const sid = (await mcp('list_sessions')).result.sessions[0].session_id;
  await mcp('end_session', { session_id: sid });
  assert.equal((await sendJsonReq(`${url}/api/settings/api-key`, 'PUT', { key: 'abcdefgh-1234' })).status, 200);
  const mode = async (p) => (await fs.stat(p)).mode & 0o777;
  assert.equal(await mode(env.dataDir), 0o700);
  assert.equal(await mode(path.join(env.dataDir, 'sessions')), 0o700);
  assert.equal(await mode(path.join(env.dataDir, 'toolkit')), 0o700);
  assert.equal(await mode(path.join(env.dataDir, 'secrets.json')), 0o600);
  assert.equal(await mode(path.join(env.dataDir, 'sessions', sid, 'meta.json')), 0o600);
  assert.deepEqual(await fs.readdir(env.projectsRoot), []);
});
