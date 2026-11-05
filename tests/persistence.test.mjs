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
  assert.equal(obs.text[0], paint.text[0], 'observe rebuilds the last frame from the compressed tail of steps.jsonl');
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

test('step lines store a compressed frame; the API returns the same rows; legacy plain-frame lines still read', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const sid = await startGame(first.mcp);
  const paint = await first.mcp('act', { session_id: sid, action: 'ACTION6', x: 7, y: 9, frame: 'full' });
  const apiSteps = (await json(`${first.url}/api/sessions/${sid}/steps`)).body.steps;
  await first.close();

  const file = path.join(env.dataDir, 'sessions', sid, 'steps.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const l of lines) {
    assert.equal(typeof l.frame_z, 'string');
    assert.equal(l.frame, undefined);
    assert.equal(Object.keys(l)[0], 'n');
  }
  assert.equal(apiSteps[1].frame.length, 64);
  assert.equal(apiSteps[1].frame[9][7], '8');
  assert.equal(apiSteps[1].frame_z, undefined);

  // A line written before compression, appended by hand; it becomes the tail.
  const legacy = { ...apiSteps[1], n: 2, action: 'ACTION4', frame: apiSteps[0].frame };
  await fs.appendFile(file, `${JSON.stringify(legacy)}\n`);
  const second = await startApp(t, { env });
  const steps = (await json(`${second.url}/api/sessions/${sid}/steps`)).body.steps;
  assert.deepEqual(steps.map((s) => s.frame), [apiSteps[0].frame, apiSteps[1].frame, apiSteps[0].frame]);
  const paged = (await json(`${second.url}/api/sessions/${sid}/steps?from=1&limit=1`)).body.steps;
  assert.deepEqual(paged.map((s) => s.n), [1]);
  // observe on the ended session reads the last frame from the legacy tail.
  const obs = await second.mcp('observe', { session_id: sid });
  assert.notEqual(obs.text[0], paint.text[0]);
  assert.equal(obs.text[0].split('\n')[2 + 9][3 + 7], apiSteps[0].frame[9][7]);
});

test('notes.jsonl survives a restart', async (t) => {
  const env = await freshEnv(t);
  const first = await startApp(t, { env });
  const r = await first.mcp('start_session', { game_id: 'fake-maze' });
  const { session_id: sid, script } = r.meta;
  const res = await sendJsonReq(`${script.base_url}attach`, 'POST', { note: 'kept across restarts' }, { authorization: `Bearer ${script.token}` });
  assert.equal(res.body.run, 1);
  await first.close();
  assert.equal(await fs.stat(path.join(env.dataDir, 'sessions', sid, 'notes.jsonl')).then((s) => s.mode & 0o777), 0o600);
  const second = await startApp(t, { env });
  const notes = (await json(`${second.url}/api/sessions/${sid}/notes`)).body.notes;
  assert.deepEqual(notes.map((n) => [n.run, n.text, n.from_step]), [[1, 'kept across restarts', 1]]);
});
