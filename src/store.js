// Persistence under $CONDUCTOR_PLUGIN_DATA_DIR — the only module that writes
// files besides the key store:
//   sessions/<sid>/meta.json    atomic, the session's current state
//   sessions/<sid>/steps.jsonl  append-only, one line per step
//   sessions/<sid>/notes.jsonl  append-only, one line per script run note
// A step line stores its frame as `frame_z` (base64 raw deflate of the rows
// joined by '\n'); every step this module hands out has `frame` rows again.
// Lines written with a plain `frame` still read. The frames of a multi-frame
// action before the last ride in `anim_z` (one deflate stream over all of
// them, blank-line separated); only readStep hands them out, as `anim`.
// The latest frame of each session is kept in memory for observe and diffs.
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { writeFileAtomic, readJsonBounded } from './atomicFile.js';
import { ANIMATION_FRAMES_MAX, COORD_MAX, SESSION_ID_RE } from './limits.js';

const META_MAX_BYTES = 64 * 1024;
// A step line holds one compressed frame (typically well under 1 KB) plus up
// to REASONING_MAX_CHARS of reasoning, and a legacy line a ~4.2 KB plain
// frame; read this much of the file's tail to find the last one.
const TAIL_READ_BYTES = 256 * 1024;
// A step line with a full animation of random frames is about 190 KB (plus up
// to REASONING_MAX_CHARS of reasoning), inside TAIL_READ_BYTES; when the first
// window still holds no complete last line, the tail is re-read this wide.
const STEP_LINE_MAX_BYTES = 512 * 1024;
// Step lines start with their number (`record` in src/sessions.js builds `n`
// first), so paging skips earlier lines without parsing them.
const STEP_N = /^\{"n":(\d+),/;

function encodeStep(step) {
  const { frame, anim, ...rest } = step;
  const out = { ...rest };
  // An empty frame has no rows to join; it stays plain.
  if (!Array.isArray(frame) || frame.length === 0) out.frame = frame;
  else out.frame_z = deflateRawSync(frame.join('\n')).toString('base64');
  if (Array.isArray(anim) && anim.length > 0) {
    out.anim_z = deflateRawSync(anim.map((f) => f.join('\n')).join('\n\n')).toString('base64');
  }
  return JSON.stringify(out);
}

// A frame is at most FRAME_SIDE rows of at most FRAME_SIDE palette digits.
const FRAME_SIDE = COORD_MAX + 1;
// Longest `rows.join('\n')` of such a frame: the inflate bound.
const FRAME_TEXT_MAX = FRAME_SIDE * FRAME_SIDE + FRAME_SIDE - 1;
const FRAME_ROW = new RegExp(`^[0-9a-f]{1,${FRAME_SIDE}}$`);
const validFrame = (f) => Array.isArray(f) && f.length >= 1 && f.length <= FRAME_SIDE && f.every((r) => typeof r === 'string' && FRAME_ROW.test(r));

function inflateFrame(z) {
  try {
    const rows = inflateRawSync(Buffer.from(z, 'base64'), { maxOutputLength: FRAME_TEXT_MAX }).toString('utf8').split('\n');
    return validFrame(rows) ? rows : null;
  } catch {
    return null; // corrupt, or inflates past a frame (a tampered line)
  }
}

// The leading frames of `anim_z`, or null when corrupt, oversized or invalid.
function inflateAnim(z) {
  try {
    const max = (ANIMATION_FRAMES_MAX - 1) * (FRAME_TEXT_MAX + 2);
    const frames = inflateRawSync(Buffer.from(z, 'base64'), { maxOutputLength: max }).toString('utf8').split('\n\n').map((f) => f.split('\n'));
    return frames.length <= ANIMATION_FRAMES_MAX - 1 && frames.every(validFrame) ? frames : null;
  } catch {
    return null;
  }
}

// One stored line back to a step with `frame` rows. Throws on malformed JSON;
// a frame that is corrupt, oversized or not hex rows reads as `frame: null`.
// `anim_z` is always stripped; with `anim: true` it comes back as `anim` (an
// array of frames, or null when it can't be read; absent when never stored).
function decodeStep(line, { anim = false } = {}) {
  const { anim_z: animZ, ...step } = JSON.parse(line);
  const out = typeof step.frame_z === 'string'
    ? (({ frame_z: z, ...rest }) => ({ ...rest, frame: inflateFrame(z) }))(step)
    : step.frame !== undefined && step.frame !== null && !validFrame(step.frame) ? { ...step, frame: null } : step;
  if (anim && typeof animZ === 'string') out.anim = inflateAnim(animZ);
  return out;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

// The file's last line: null when the file is missing or empty, undefined when
// it has content but no whole last line fits the tail windows.
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
    // The last line in the file's final `want` bytes; `whole` is false when it
    // may start before the window.
    const tail = async (want) => {
      const len = Math.min(size, want);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      if (!lines.length) return { line: null, whole: true };
      return { line: lines[lines.length - 1], whole: len === size || lines.length > 1 };
    };
    const first = await tail(TAIL_READ_BYTES);
    if (first.whole) return first.line;
    const wide = await tail(Math.min(size, STEP_LINE_MAX_BYTES));
    return wide.whole ? wide.line : undefined;
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
        const file = path.join(dirOf(id), 'steps.jsonl');
        const line = await lastLine(file);
        if (line === undefined) {
          log.error(`[code-arc] session ${id}: the newest step line is unreadable (oversized or torn); no last frame restored`);
        } else if (line) {
          try {
            const step = decodeStep(line);
            if (Array.isArray(step.frame)) lastFrames.set(id, step.frame);
          } catch (e) {
            log.error(`[code-arc] session ${id}: the newest step line is unreadable: ${e.message}`);
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

    // One step by number with its animation (`anim`: frames before the last, or
    // null when unreadable; absent when none were stored), or null.
    async readStep(id, n) {
      const file = path.join(dirOf(id), 'steps.jsonl');
      const lastLn = await lastLine(file);
      const m = typeof lastLn === 'string' ? STEP_N.exec(lastLn) : null;
      if (m && Number(m[1]) === n) {
        try { return decodeStep(lastLn, { anim: true }); } catch { /* fall through to the scan */ }
      }
      try {
        await fs.access(file);
      } catch {
        return null;
      }
      const stream = createReadStream(file, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (!line) continue;
          const lm = STEP_N.exec(line);
          if (lm && Number(lm[1]) !== n) continue;
          let step;
          try { step = decodeStep(line, { anim: true }); } catch { continue; }
          if (step.n === n) return step;
        }
      } finally {
        rl.close();
        stream.destroy();
      }
      return null;
    },

    // Resolves once every queued write has landed.
    async flush() {
      await Promise.all([...chains.values()]);
    },
  };
}
