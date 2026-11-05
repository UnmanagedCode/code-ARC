// Board image files of live sessions: <dataDir>/images/<sid>/step-<n>-<seq>.png.
// `seq` counts a session's writes, so every image gets a path of its own and a
// reader never sees a cached older copy. Only the newest file per session is
// kept; a session's dir is removed when it ends, and all of images/ at start
// (no session survives a restart). Writes and prunes for one session run in
// call order, and a write checks `isLive` when its turn comes: end() marks the
// session ended before it queues the prune, so a write either lands before the
// prune (which removes it) or finds the session ended and writes nothing.
//
// Game code runs as the same user with its cwd under the data dir, so it can
// plant symlinks here. images/ and each session dir must be real directories
// (never followed, never chmod'ed through a link) whose realpaths nest, and
// latest-only unlinks only the file this process wrote before, never a
// directory listing.
import { constants as FS, promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomicFile.js';
import { boardPng } from './boardImage.js';
import { SESSION_ID_RE } from './limits.js';

const notRealDir = (dir) => new Error(`board image: ${dir} is not a real directory (a symlink or another file is in its place)`);

// Creates `dir` (its parent must exist) if missing and makes it 0700. Refuses
// anything but a real directory; the chmod goes through a descriptor opened
// with O_NOFOLLOW, so it never reaches a symlink's target.
async function realDir(dir) {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw notRealDir(dir);
  let fh;
  try {
    fh = await fs.open(dir, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'ENOTDIR') throw notRealDir(dir);
    throw e;
  }
  try {
    await fh.chmod(0o700);
  } finally {
    await fh.close();
  }
}

export function createBoardImages({ dataDir, isLive }) {
  const imagesDir = path.join(dataDir, 'images');
  const chains = new Map();
  const seqs = new Map();
  // id -> absolute path of the session's current image (the one file
  // latest-only may remove).
  const latest = new Map();

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
      // rm never follows a symlink: a planted link is removed, its target kept.
      await fs.rm(imagesDir, { recursive: true, force: true });
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await realDir(imagesDir);
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
        await realDir(imagesDir);
        await realDir(dir);
        const [realImages, realSession] = await Promise.all([fs.realpath(imagesDir), fs.realpath(dir)]);
        if (path.dirname(realSession) !== realImages) throw new Error(`board image: ${dir} resolves outside ${imagesDir}`);
        await writeFileAtomic(file, png);
        const prev = latest.get(id);
        latest.set(id, file);
        if (prev) {
          await fs.unlink(prev).catch((e) => { if (e.code !== 'ENOENT') throw e; });
        }
        return { path: file };
      });
    },

    // Removes the session's image dir (queued after its pending writes).
    async prune(id) {
      const dir = sessionDir(id);
      return chain(id, async () => {
        seqs.delete(id);
        latest.delete(id);
        let st;
        try {
          st = await fs.lstat(imagesDir);
        } catch (e) {
          if (e.code === 'ENOENT') return;
          throw e;
        }
        if (st.isSymbolicLink() || !st.isDirectory()) throw notRealDir(imagesDir);
        // A symlink in the session dir's place is unlinked; its target is kept.
        await fs.rm(dir, { recursive: true, force: true });
      });
    },
  };
}
