// Persistence under $CONDUCTOR_PLUGIN_DATA_DIR — the only module that writes
// files besides the key store:
//   sessions/<sid>/meta.json    atomic, the session's current state
//   sessions/<sid>/steps.jsonl  append-only, one line per step
//   sessions/<sid>/notes.jsonl  append-only, one line per script run note
// A step line stores its frame as `frame_z` (base64 raw deflate of the rows
// joined by '\n'); every step this module hands out has `frame` rows again.
// Lines written with a plain `frame` still read.
// The latest frame of each session is kept in memory for observe and diffs.
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { writeFileAtomic, readJsonBounded } from './atomicFile.js';
import { SESSION_ID_RE } from './limits.js';

const META_MAX_BYTES = 64 * 1024;
// A step line holds one compressed frame (typically well under 1 KB) plus up
// to REASONING_MAX_CHARS of reasoning, and a legacy line a ~4.2 KB plain
// frame; read this much of the file's tail to find the last one.
const TAIL_READ_BYTES = 256 * 1024;
// Step lines start with their number (`record` in src/sessions.js builds `n`
// first), so paging skips earlier lines without parsing them.
const STEP_N = /^\{"n":(\d+),/;

function encodeStep(step) {
  // An empty frame has no rows to join; it stays plain.
  if (!Array.isArray(step.frame) || step.frame.length === 0) return JSON.stringify(step);
  const { frame, ...rest } = step;
  return JSON.stringify({ ...rest, frame_z: deflateRawSync(frame.join('\n')).toString('base64') });
}

// One stored line back to a step with `frame` rows. Throws on a malformed line.
function decodeStep(line) {
  const step = JSON.parse(line);
  if (typeof step.frame_z === 'string') {
    const { frame_z: z, ...rest } = step;
    return { ...rest, frame: inflateRawSync(Buffer.from(z, 'base64')).toString('utf8').split('\n') };
  }
  return step;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function lastLine(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, TAIL_READ_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.length ? lines[lines.length - 1] : null;
  } finally {
    await fh.close();
  }
}

export function createStore({ dataDir, log = console }) {
  const sessionsDir = path.join(dataDir, 'sessions');
  const metas = new Map();
  const lastFrames = new Map();
  const chains = new Map();

  const dirOf = (id) => path.join(sessionsDir, id);

  // Serialise writes per session.
  function chain(id, fn) {
    const prev = chains.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(id, next.catch(() => {}));
    return next;
  }

  async function writeMeta(meta) {
    await writeFileAtomic(path.join(dirOf(meta.id), 'meta.json'), JSON.stringify(meta));
  }

  return {
    toolkitDir: path.join(dataDir, 'toolkit'),

    async init() {
      await ensureDir(dataDir);
      await ensureDir(sessionsDir);
      await ensureDir(path.join(dataDir, 'toolkit'));
      for (const id of await fs.readdir(sessionsDir)) {
        if (!SESSION_ID_RE.test(id)) continue;
        let meta;
        try {
          meta = await readJsonBounded(path.join(dirOf(id), 'meta.json'), META_MAX_BYTES);
        } catch (e) {
          log.error(`[code-arc] skipping session ${id}: ${e.message}`);
          continue;
        }
        if (!meta || meta.id !== id) continue;
        if (meta.status === 'live') {
          // Toolkit environments don't survive a backend restart.
          meta = { ...meta, status: 'ended', end_reason: 'backend_restart', stalled: false };
          await writeMeta(meta);
        }
        metas.set(id, meta);
        const line = await lastLine(path.join(dirOf(id), 'steps.jsonl'));
        if (line) {
          try {
            const step = decodeStep(line);
            if (Array.isArray(step.frame)) lastFrames.set(id, step.frame);
          } catch {
            log.error(`[code-arc] session ${id}: last step line is malformed`);
          }
        }
      }
    },

    // Newest first (created_at, then id, both descending).
    list() {
      return [...metas.values()].sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    },

    // One page of list(): sessions after the `before` id (from the start
    // when absent), at most `limit`. `next` is the cursor for the following
    // page, null at the end; `total` counts every stored session.
    page({ before = null, limit }) {
      const all = this.list();
      let start = 0;
      if (before) {
        const i = all.findIndex((m) => m.id === before);
        start = i < 0 ? all.length : i + 1;
      }
      const sessions = all.slice(start, start + limit);
      const more = start + limit < all.length;
      return { sessions, total: all.length, next: more && sessions.length ? sessions.at(-1).id : null };
    },
    get: (id) => metas.get(id) || null,
    lastFrame: (id) => lastFrames.get(id) || null,

    create(meta) {
      metas.set(meta.id, meta);
      return chain(meta.id, async () => {
        await ensureDir(dirOf(meta.id));
        await writeMeta(meta);
      });
    },

    // Applies `patch` to the in-memory meta now and persists it in order.
    update(id, patch) {
      const meta = { ...metas.get(id), ...patch };
      metas.set(id, meta);
      return chain(id, () => writeMeta(meta)).then(() => meta);
    },

    appendStep(id, step) {
      if (Array.isArray(step.frame)) lastFrames.set(id, step.frame);
      const line = `${encodeStep(step)}\n`;
      return chain(id, () => fs.appendFile(path.join(dirOf(id), 'steps.jsonl'), line, { mode: 0o600 }));
    },

    appendNote(id, note) {
      const line = `${JSON.stringify(note)}\n`;
      return chain(id, () => fs.appendFile(path.join(dirOf(id), 'notes.jsonl'), line, { mode: 0o600 }));
    },

    // Every note of a session, in order (at most NOTES_MAX are ever written).
    async readNotes(id) {
      let text;
      try {
        text = await fs.readFile(path.join(dirOf(id), 'notes.jsonl'), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
      const out = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
      }
      return out;
    },

    // Steps with n >= from, at most `limit`, in order.
    async readSteps(id, from, limit) {
      const file = path.join(dirOf(id), 'steps.jsonl');
      const out = [];
      let stream;
      try {
        await fs.access(file);
        stream = createReadStream(file, { encoding: 'utf8' });
      } catch {
        return out;
      }
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (!line) continue;
          const m = STEP_N.exec(line);
          if (m && Number(m[1]) < from) continue;
          let step;
          try { step = decodeStep(line); } catch { continue; }
          if (step.n < from) continue;
          out.push(step);
          if (out.length >= limit) break;
        }
      } finally {
        rl.close();
        stream.destroy();
      }
      return out;
    },

    // Resolves once every queued write has landed.
    async flush() {
      await Promise.all([...chains.values()]);
    },
  };
}
