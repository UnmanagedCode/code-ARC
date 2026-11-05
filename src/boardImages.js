// Board image files of live sessions: <dataDir>/images/<sid>/step-<n>-<seq>.png.
// `seq` counts a session's writes, so every image gets a path of its own and a
// reader never sees a cached older copy. Only the newest file per session is
// kept; a session's dir is removed when it ends, and all of images/ at start
// (no session survives a restart). Writes and prunes for one session run in
// call order, and a write checks `isLive` when its turn comes: end() marks the
// session ended before it queues the prune, so a write either lands before the
// prune (which removes it) or finds the session ended and writes nothing.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomicFile.js';
import { boardPng } from './boardImage.js';
import { SESSION_ID_RE } from './limits.js';
import { ensureDir } from './store.js';

export function createBoardImages({ dataDir, isLive }) {
  const imagesDir = path.join(dataDir, 'images');
  const chains = new Map();
  const seqs = new Map();

  function chain(id, fn) {
    const prev = chains.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    chains.set(id, tail);
    tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
    return next;
  }

  function sessionDir(id) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Error(`board image: invalid session id ${JSON.stringify(String(id).slice(0, 64))}`);
    const dir = path.join(imagesDir, id);
    if (path.dirname(dir) !== imagesDir) throw new Error(`board image: ${id} escapes the images dir`);
    return dir;
  }

  return {
    async init() {
      await fs.rm(imagesDir, { recursive: true, force: true });
      await ensureDir(imagesDir);
    },

    // {path} (absolute) of the written PNG, or {ended:true} when the session
    // was no longer live at its turn. Throws on a bad id, step or frame, and
    // on fs errors.
    async write(id, step, rows, opts) {
      const dir = sessionDir(id);
      if (!Number.isInteger(step) || step < 0) throw new Error(`board image: invalid step ${JSON.stringify(step)}`);
      return chain(id, async () => {
        if (!isLive(id)) return { ended: true };
        const png = boardPng(rows, opts);
        const seq = (seqs.get(id) || 0) + 1;
        seqs.set(id, seq);
        const file = path.join(dir, `step-${step}-${seq}.png`);
        if (path.dirname(file) !== dir) throw new Error(`board image: ${file} escapes ${dir}`);
        await ensureDir(dir);
        await writeFileAtomic(file, png);
        const keep = path.basename(file);
        for (const name of await fs.readdir(dir)) {
          if (name !== keep) await fs.rm(path.join(dir, name), { recursive: true, force: true });
        }
        return { path: file };
      });
    },

    // Removes the session's image dir (queued after its pending writes).
    async prune(id) {
      const dir = sessionDir(id);
      return chain(id, async () => {
        seqs.delete(id);
        await fs.rm(dir, { recursive: true, force: true });
      });
    },
  };
}
