// Writes one sample board image for a visual check: boots the backend
// in-process on a fresh temp data dir and the fake toolkit, plays two moves of
// fake-maze, asks observe for frame:'image' and prints {path, data_dir}. The
// session is not ended, so the image stays; delete the data dir when done.
//   node harness/board-image.mjs [--scale N] [--no-grid]
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const args = { frame: 'image' };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--no-grid') args.image_grid = false;
  else if (argv[i] === '--scale') args.image_scale = Number(argv[++i]);
  else throw new Error(`unknown argument ${argv[i]}; usage: node harness/board-image.mjs [--scale N] [--no-grid]`);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-arc-board-image-'));
const app = await createApp({
  config: { dataDir, port: 0, checkoutDir: REPO, python: 'python3', testToolkitDir: path.join(REPO, 'sidecar', 'tests', 'fakes') },
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
try {
  const call = async (tool, a) => {
    const r = await app.mcp.handle({ tool, arguments: a, caller: { sessionId: 'harness', project: 'harness' }, format: 'json' });
    if (!r.structured) throw new Error(`${tool} failed: ${JSON.stringify(r)}`);
    return r.structured;
  };
  const sid = (await call('start_session', { game_id: 'fake-maze' })).session_id;
  await call('act', { session_id: sid, action: 'ACTION4' });
  await call('act', { session_id: sid, action: 'ACTION6', x: 10, y: 20 });
  const r = await call('observe', { session_id: sid, ...args });
  if (!r.frame.path) throw new Error(`no image: ${JSON.stringify(r.frame)}`);
  console.log(JSON.stringify({ path: r.frame.path, data_dir: dataDir }));
  console.log(`# when done: rm -rf ${dataDir}`);
} finally {
  await app.close();
}
