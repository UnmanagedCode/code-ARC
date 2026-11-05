// Script tokens and runs per session, in memory only: a token dies with the
// process (and a restart ends every session anyway). Only the sha256 of a
// token is held; verification is constant-time. A run is the segment opened by
// one note (attach or note); script moves must name the current run.
// No I/O, no logging.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest();

export function createScriptAccess() {
  const entries = new Map(); // id -> {hash, runs, current}

  return {
    // A fresh token for `id`; the previous one stops verifying and the
    // current run is cleared (run numbers keep counting).
    mint(id) {
      const token = randomBytes(32).toString('base64url');
      entries.set(id, { hash: sha256(token), runs: entries.get(id)?.runs ?? 0, current: null });
      return token;
    },

    verify(id, presented) {
      const e = entries.get(id);
      if (!e || typeof presented !== 'string') return false;
      return timingSafeEqual(sha256(presented), e.hash);
    },

    // Opens the next run and makes it current; returns its number.
    openRun(id) {
      const e = entries.get(id);
      e.runs++;
      e.current = e.runs;
      return e.current;
    },

    // null when `run` is the current run, else the refusal code.
    checkRun(id, run) {
      const e = entries.get(id);
      if (!e || e.current === null) return 'NOTE_REQUIRED';
      return run === e.current ? null : 'RUN_SUPERSEDED';
    },

    // Runs opened so far (= notes written in this process).
    runCount: (id) => entries.get(id)?.runs ?? 0,
  };
}
