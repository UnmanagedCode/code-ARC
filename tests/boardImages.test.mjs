// Board image files (src/boardImages.js): latest only, path-safe, never
// outliving their session, cleared at start; and every session end path
// through a real app prunes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createBoardImages } from '../src/boardImages.js';
import { freshEnv, startApp, startGame } from './_helpers.mjs';

const SID = 's-0123456789ab';
const ROWS = ['0123', '4567', '89ab', 'cdef'];
const OPTS = { scale: 4, grid: false };

async function images(t, { live = () => true } = {}) {
  const env = await freshEnv(t);
  const img = createBoardImages({ dataDir: env.dataDir, isLive: (id) => live(id) });
  await img.init();
  return { env, img, dir: path.join(env.dataDir, 'images') };
}

const exists = (p) => fs.stat(p).then(() => true, () => false);
const mode = async (p) => (await fs.stat(p)).mode & 0o777;

test('latest only: a second write leaves just its own file, 0600 in a 0700 dir', async (t) => {
  const { img, dir } = await images(t);
  const a = await img.write(SID, 3, ROWS, OPTS);
  const b = await img.write(SID, 4, ROWS, OPTS);
  assert.ok(path.isAbsolute(b.path));
  assert.notEqual(a.path, b.path);
  assert.equal(path.dirname(b.path), path.join(dir, SID));
  assert.match(path.basename(b.path), /^step-4-\d+\.png$/);
  assert.deepEqual(await fs.readdir(path.join(dir, SID)), [path.basename(b.path)]);
  assert.equal(await mode(b.path), 0o600);
  assert.equal(await mode(path.join(dir, SID)), 0o700);
  assert.equal(await mode(dir), 0o700);
});

test('two writes at the same step get distinct paths', async (t) => {
  const { img } = await images(t);
  const a = await img.write(SID, 7, ROWS, OPTS);
  const b = await img.write(SID, 7, ROWS, { scale: 8, grid: true });
  assert.notEqual(a.path, b.path);
  assert.equal(await exists(a.path), false);
  assert.equal(await exists(b.path), true);
});

test('path safety: malformed ids and steps throw and create nothing', async (t) => {
  const { img, env, dir } = await images(t);
  const before = await fs.readdir(env.dataDir);
  for (const id of ['../x', 's-ZZ', 's-0123456789ab/..', '', 's-0123456789abc']) {
    await assert.rejects(img.write(id, 1, ROWS, OPTS), /session id/, id);
    await assert.rejects(img.prune(id), /session id/, id);
  }
  for (const step of [-1, 1.5, '2', null]) await assert.rejects(img.write(SID, step, ROWS, OPTS), /step/, String(step));
  assert.deepEqual(await fs.readdir(env.dataDir), before);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('a frame the renderer refuses rejects the write and leaves no file', async (t) => {
  const { img, dir } = await images(t);
  await assert.rejects(img.write(SID, 1, ['01', '0'], OPTS), /ragged/);
  assert.deepEqual(await fs.readdir(path.join(dir, SID)).catch(() => []), []);
});

test('no image outlives its session: an end while a write runs prunes its file', async (t) => {
  // The session ends right after the write passed its liveness check, as
  // end() would: mark ended, then queue the prune.
  let live = true;
  let pruned = null;
  const ctx = await images(t, {
    live: () => {
      const was = live;
      if (was) { live = false; pruned = ctx.img.prune(SID); }
      return was;
    },
  });
  const { img, dir } = ctx;
  const written = await img.write(SID, 1, ROWS, OPTS);
  assert.ok(written.path, 'the write had passed its check and went ahead');
  await pruned;
  assert.equal(await exists(written.path), false);
  assert.equal(await exists(path.join(dir, SID)), false);
  // A write queued after the end resolves {ended} and creates nothing.
  assert.deepEqual(await img.write(SID, 2, ROWS, OPTS), { ended: true });
  assert.equal(await exists(path.join(dir, SID)), false);
});

test('a write that finds its session ended before it runs writes nothing', async (t) => {
  let live = true;
  const { img, dir } = await images(t, { live: () => live });
  const first = img.write(SID, 1, ROWS, OPTS);
  const second = img.write(SID, 2, ROWS, OPTS);
  live = false;
  assert.deepEqual(await first, { ended: true });
  assert.deepEqual(await second, { ended: true });
  assert.equal(await exists(path.join(dir, SID)), false);
});

test('restart leftovers are cleared when the app starts', async (t) => {
  const env = await freshEnv(t);
  const stale = path.join(env.dataDir, 'images', SID);
  await fs.mkdir(stale, { recursive: true });
  await fs.writeFile(path.join(stale, 'step-3-1.png'), 'x');
  await fs.writeFile(path.join(stale, 'step-4-2.png.123.abcd.tmp'), 'x');
  await startApp(t, { env });
  assert.deepEqual(await fs.readdir(path.join(env.dataDir, 'images')), []);
  assert.equal(await mode(path.join(env.dataDir, 'images')), 0o700);
});

test('every end path prunes the session image: end_session and sidecar exit', async (t) => {
  const { mcp, app, env } = await startApp(t);
  const dir = path.join(env.dataDir, 'images');

  const a = await startGame(mcp);
  const r = await mcp('act', { session_id: a, action: 'ACTION4', frame: 'image' });
  assert.equal(await exists(r.meta.frame.path), true);
  assert.equal((await mcp('end_session', { session_id: a })).result.ok, true);
  assert.equal(await exists(path.join(dir, a)), false);

  const b = await startGame(mcp);
  const o = await mcp('observe', { session_id: b, frame: 'image' });
  assert.equal(await exists(o.meta.frame.path), true);
  await app.sessions.onSidecarExit();
  assert.equal(app.store.get(b).end_reason, 'sidecar_exit');
  assert.equal(await exists(path.join(dir, b)), false);
  assert.deepEqual(await fs.readdir(dir), []);
});
