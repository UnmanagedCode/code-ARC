// The session service: lifecycle, ownership, gating, ONLINE and step limits,
// script access, the idle sweep and live events. Shared by the MCP handlers,
// the script routes and the HTTP read routes.
// Every public method resolves; a refusal is {ok:false, code, reason, ...}.
// A caller is either a tool caller {sessionId, project} (ownership applies) or
// a script caller {script:{token, run}} (the token replaces ownership).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  ACTIONS, COMPLEX_ACTION, COORD_MAX, DEADLINES, DETAIL_MAX, GAME_ID_RE, LIST_SESSIONS_MAX, MAX_LIVE_SESSIONS, NOTE_MAX_CHARS, NOTES_MAX,
  REASONING_MAX_CHARS, SESSION_STEPS_MAX, STEP_RATE_MAX, STEP_RATE_WINDOW_MS,
} from './limits.js';
import { createRateLimiter, idleCloseAt, ONLINE_IDLE_CLOSE_MS, ONLINE_RPM_LIMIT, scorecardUrl } from './online.js';
import { createScriptAccess } from './scriptAccess.js';

const SWEEP_MS = 60 * 1000;
const FINISHED = new Set(['WIN', 'GAME_OVER']);
// Codes the sidecar may answer that pass through to the agent unchanged.
const PASS_THROUGH = new Set(['TOOLKIT_TIMEOUT', 'TOOLKIT_ERROR', 'SIDECAR_EXITED', 'NETWORK_ERROR', 'RATE_LIMITED', 'SCORECARD_CLOSED', 'GAME_UNKNOWN', 'INVALID_ARGUMENT', 'SESSION_BUSY', 'TOOLKIT_NOT_READY']);
const REASONS = {
  TOOLKIT_TIMEOUT: 'the toolkit did not answer in time; the session is stalled until it does — call observe before acting again',
  TOOLKIT_ERROR: 'the toolkit failed this call',
  SIDECAR_EXITED: 'the toolkit process exited; live sessions were ended',
  NETWORK_ERROR: 'the toolkit could not reach arcprize.org',
  RATE_LIMITED: 'arcprize.org rate limit reached; wait retry_after_ms (if given) once, do not loop',
  SCORECARD_CLOSED: 'the scorecard is closed (arcprize.org closes idle ones); this session is over',
  GAME_UNKNOWN: 'no such game; call list_games',
  INVALID_ARGUMENT: 'invalid argument',
  SESSION_BUSY: 'another call on this session is in flight',
  TOOLKIT_NOT_READY: 'the toolkit is still being installed; try again shortly',
};

export const refuse = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });
export const actionName = (n) => (n === 0 ? 'RESET' : `ACTION${n}`);
const newId = () => `s-${randomBytes(6).toString('hex')}`;
const TOOL = Object.freeze({ source: 'tool' });
const RUN_REFUSALS = {
  NOTE_REQUIRED: 'no script run is open: attach (or note) with a note saying what the script tries and why',
  RUN_SUPERSEDED: 'a newer attach or note opened another run; this run is over — attach again to continue',
};
const lastSummary = (o) => ({ state: o.state, levels_completed: o.levels_completed, win_levels: o.win_levels, available_actions: o.available_actions, frame_count: o.frame_count, full_reset: o.full_reset });

// `scriptBase()` is the script API root URL (…/api/play/); `checkoutDir`
// locates the Python client handed to agents.
export function createSessions({
  store, sidecar, bootstrap, hub, scriptBase, checkoutDir,
  clock = { now: Date.now }, timers = { setInterval, clearInterval }, log = console, idGen = newId, deadlines = DEADLINES,
  onlineRpmLimit = ONLINE_RPM_LIMIT, stepRate = { max: STEP_RATE_MAX, windowMs: STEP_RATE_WINDOW_MS },
}) {
  const runtime = new Map(); // id -> {inflight, stalled, steps}
  const limiter = createRateLimiter({ clock, limit: onlineRpmLimit });
  const access = createScriptAccess();
  const clientPath = path.join(checkoutDir, 'clients', 'code_arc.py');
  // Starts in flight count toward the live cap from their check until the
  // store holds the session; a key change runs only with none live or pending
  // and blocks starts while it runs. Each check and its reservation happen in
  // one synchronous block, so no await can interleave them.
  let pendingStarts = 0;
  let keyChanging = false;
  let gamesCache = null;

  const iso = (ms = clock.now()) => new Date(ms).toISOString();
  const rt = (id) => {
    if (!runtime.has(id)) runtime.set(id, { inflight: false, stalled: false, steps: createRateLimiter({ clock, limit: stepRate.max, windowMs: stepRate.windowMs }) });
    return runtime.get(id);
  };
  const live = () => store.list().filter((m) => m.status === 'live');
  const liveCount = () => live().length + pendingStarts;

  function publishSession(meta) {
    hub.publish('session', meta);
  }

  function onlineInfo(meta) {
    if (meta.mode !== 'online') return undefined;
    return { scorecard_url: meta.scorecard_url, idle_close_at: iso(idleCloseAt(Date.parse(meta.last_activity_at))) };
  }

  function toolkitGate() {
    const st = bootstrap.status();
    if (st.state === 'ready') return null;
    if (st.state === 'diverged') return refuse('DEPS_DIVERGED', 'the shared toolkit venv does not match this checkout\'s requirements.txt', { detail: st.detail, fix: st.fix });
    if (st.state === 'failed') return refuse('TOOLKIT_UNAVAILABLE', 'the toolkit could not be installed', { detail: String(st.detail || '').slice(0, DETAIL_MAX), fix: st.fix });
    return refuse('TOOLKIT_NOT_READY', REASONS.TOOLKIT_NOT_READY, { state: st.state, phase: st.phase });
  }

  function sidecarRefusal(r, extra = {}) {
    const code = PASS_THROUGH.has(r.code) ? r.code : 'TOOLKIT_ERROR';
    return refuse(code, REASONS[code], { detail: String(r.detail || '').slice(0, DETAIL_MAX), ...extra });
  }

  function rateGate(meta, cost) {
    if (meta && meta.mode !== 'online') return null;
    const t = limiter.take(cost);
    return t.ok ? null : refuse('RATE_LIMITED', `the local guard for arcprize.org's ${onlineRpmLimit}-requests-per-minute limit refused this call; it was not sent`, { retry_after_ms: t.retryAfterMs });
  }

  // The per-session step rate (tools and scripts alike).
  function stepRateGate(id) {
    const t = rt(id).steps.take(1);
    return t.ok ? null : refuse('STEP_RATE_LIMITED', `at most ${stepRate.max} steps per ${stepRate.windowMs} ms on one session; wait retry_after_ms once, do not loop`, { retry_after_ms: t.retryAfterMs });
  }

  // Step-taking calls past the per-session cap, then the step rate.
  function stepGates(id, meta) {
    if (meta.step_count >= SESSION_STEPS_MAX) return refuse('SESSION_STEP_LIMIT', `this session has reached ${SESSION_STEPS_MAX} steps; end_session and start a new one`);
    return stepRateGate(id);
  }

  const noteInvalid = (note) => (typeof note !== 'string' || note.trim().length === 0 || note.length > NOTE_MAX_CHARS
    ? refuse('INVALID_ARGUMENT', `note must be a non-blank string of at most ${NOTE_MAX_CHARS} characters`)
    : null);

  const scriptBlock = (id, base, token) => ({ base_url: `${base}${id}/`, token, client: clientPath });

  async function end(id, reason, extra = {}) {
    const meta = store.get(id);
    if (!meta || meta.status !== 'live') return meta;
    // The in-memory meta is ended as soon as update() is called, so no gate
    // admits the session again and nothing re-creates the entries pruned here.
    const saved = store.update(id, { status: 'ended', end_reason: reason, stalled: false, updated_at: iso(), ...extra });
    runtime.delete(id);
    access.forget(id);
    const next = await saved;
    publishSession(next);
    return next;
  }

  // `tag` is {source:'tool'} or {source:'script', run}; never sent to the toolkit.
  async function record(id, action, args, obs, tag) {
    const meta = store.get(id);
    const n = meta.step_count + 1;
    // `n` first: the store pages by a line prefix.
    const step = { n, ts: iso(), action, ...tag, ...args, ...lastSummary(obs), frame: obs.frame };
    const prev = store.lastFrame(id);
    await store.appendStep(id, step);
    const now = iso();
    const next = await store.update(id, { step_count: n, last: lastSummary(obs), updated_at: now, last_activity_at: now, stalled: false });
    hub.publish('step', { session_id: id, step });
    publishSession(next);
    return { ok: true, meta: next, obs, prev, online: onlineInfo(next) };
  }

  // Who may touch a live session: a script caller by its token (and, with
  // `run`, the current run), a tool caller by ownership. An ended session
  // refuses before the token is checked: its status and end_reason are public
  // (GET api/sessions/:id) and its token entry is pruned at the end.
  function admit(id, caller, { run = false } = {}) {
    const meta = store.get(id);
    if (!meta) return { refusal: refuse('SESSION_UNKNOWN', 'no such session; list_sessions recovers ids') };
    if (meta.status !== 'live') return { refusal: refuse('SESSION_ENDED', 'this session has ended', { end_reason: meta.end_reason }) };
    const script = caller?.script;
    if (script && !access.verify(id, script.token)) {
      return { refusal: refuse('TOKEN_INVALID', 'the script token is not valid for this session (missing, wrong, or replaced by script_access)') };
    }
    if (script) {
      const code = run ? access.checkRun(id, script.run) : null;
      if (code) return { refusal: refuse(code, RUN_REFUSALS[code]) };
      return { meta };
    }
    const owner = meta.owner?.sessionId;
    const who = caller?.sessionId ?? null;
    if (owner && who && owner !== who) return { refusal: refuse('NOT_OWNER', 'another agent session started this game; leave it alone') };
    return { meta };
  }

  // Common gating for calls that reach the toolkit on a live session.
  function gate(id, caller, { allowStalled = false } = {}) {
    const a = admit(id, caller, { run: true });
    if (a.refusal) return a;
    const { meta } = a;
    const r = rt(id);
    if (r.inflight) return { refusal: refuse('SESSION_BUSY', REASONS.SESSION_BUSY) };
    if (r.stalled && !allowStalled) return { refusal: refuse('SESSION_STALLED', 'a previous call timed out and has not finished; call observe, then retry later') };
    const tk = toolkitGate();
    if (tk) return { refusal: tk };
    return { meta, r };
  }

  // A call that timed out answered late: apply it so history matches the toolkit.
  function lateHandler(id, action, args, tag) {
    return (reply) => {
      const meta = store.get(id);
      // Ended meanwhile: its runtime entry is gone; don't re-create it.
      if (!meta || meta.status !== 'live') return;
      rt(id).stalled = false;
      const done = reply.ok
        ? record(id, action, args, reply.result.obs, tag)
        : reply.code === 'SCORECARD_CLOSED'
          ? end(id, 'scorecard_auto_closed')
          : store.update(id, { stalled: false, updated_at: iso() }).then(publishSession);
      done.catch((e) => log.error(`[code-arc] applying a late ${action} reply to ${id} failed: ${e.message}`));
    };
  }

  async function runStep(id, meta, r, op, action, args, sidecarArgs, tag) {
    r.inflight = true;
    let res;
    try {
      res = await sidecar.call(op, { session_id: id, ...sidecarArgs }, { timeoutMs: deadlines[op], onLate: lateHandler(id, action, args, tag) });
    } finally {
      r.inflight = false;
    }
    if (res.ok) return record(id, action, args, res.result.obs, tag);
    if (res.code === 'TOOLKIT_TIMEOUT') {
      r.stalled = true;
      publishSession(await store.update(id, { stalled: true, updated_at: iso() }));
    } else if (res.code === 'SCORECARD_CLOSED') {
      await end(id, 'scorecard_auto_closed');
    } else if (res.code === 'SESSION_UNKNOWN') {
      await end(id, 'sidecar_exit');
      return refuse('SESSION_ENDED', 'the toolkit lost this session', { end_reason: 'sidecar_exit' });
    }
    return sidecarRefusal(res, meta.mode === 'online' ? { online: onlineInfo(meta) } : {});
  }

  async function knownGames(refresh) {
    if (gamesCache && !refresh) return { ok: true, games: gamesCache };
    const tk = toolkitGate();
    if (tk) return tk;
    const res = await sidecar.call('list_games', {}, { timeoutMs: deadlines.list_games });
    if (!res.ok) return sidecarRefusal(res);
    gamesCache = res.result.games;
    return { ok: true, games: gamesCache };
  }

  const tagOf = (caller) => (caller?.script ? { source: 'script', run: caller.script.run } : TOOL);

  function observed(meta) {
    const obs = { ...meta.last, frame: store.lastFrame(meta.id) };
    return { ok: true, meta, obs, prev: null, online: meta.status === 'live' ? onlineInfo(meta) : undefined };
  }

  // Validates the note, opens the run (synchronously, so concurrent attaches
  // get distinct runs), persists and announces the note.
  async function openRun(id, meta, text) {
    const bad = noteInvalid(text);
    if (bad) return bad;
    if (access.runCount(id) >= NOTES_MAX) return refuse('TOO_MANY_NOTES', `at most ${NOTES_MAX} notes per session; end_session and start a new one`);
    const sr = stepRateGate(id);
    if (sr) return sr;
    const run = access.openRun(id);
    const note = { run, ts: iso(), text, from_step: meta.step_count + 1 };
    await store.appendNote(id, note);
    hub.publish('note', { session_id: id, note });
    return { ok: true, run };
  }

  const gameListed = (games, gid) => games.some((g) => g.game_id === gid || g.game_id.split('-')[0] === gid);

  const sweepTimer = timers.setInterval(() => { sweep().catch((e) => log.error(`[code-arc] idle sweep failed: ${e.message}`)); }, SWEEP_MS);
  sweepTimer?.unref?.();

  async function sweep() {
    const now = clock.now();
    for (const meta of live()) {
      if (meta.mode !== 'online') continue;
      if (now - Date.parse(meta.last_activity_at) < ONLINE_IDLE_CLOSE_MS) continue;
      if (rt(meta.id).inflight) continue;
      await end(meta.id, 'scorecard_auto_closed');
      sidecar.call('drop', { session_id: meta.id }, { timeoutMs: deadlines.drop }).catch(() => {});
    }
  }

  return {
    sweep,

    // The script route's gate before its body schema: SESSION_UNKNOWN →
    // SESSION_ENDED → TOKEN_INVALID. Returns the refusal, or null.
    admitScript: (id, token) => admit(id, { script: { token } }).refusal || null,

    // Per-session in-memory entries (runtime state, script tokens); test seam.
    _entryCounts: () => ({ runtime: runtime.size, tokens: access.size() }),

    async listGames() {
      const r = await knownGames(true);
      return r.ok ? { ok: true, games: r.games } : r;
    },

    async start({ game_id: gameId, online = false }, caller) {
      const tk = toolkitGate();
      if (tk) return tk;
      if (typeof gameId !== 'string' || !GAME_ID_RE.test(gameId)) return refuse('INVALID_ARGUMENT', 'game_id is malformed');
      if (keyChanging) return refuse('TOOLKIT_NOT_READY', 'the API key is being changed; try again shortly', { state: 'reconfiguring' });
      if (liveCount() >= MAX_LIVE_SESSIONS) return refuse('TOO_MANY_SESSIONS', `at most ${MAX_LIVE_SESSIONS} live sessions; end_session one first`, { live: live().map((m) => m.id) });
      pendingStarts++;
      // Released as soon as the store counts the session as live.
      let pendingReleased = false;
      try {
        let games = await knownGames(false);
        if (!games.ok) return games;
        if (!gameListed(games.games, gameId)) {
          games = await knownGames(true);
          if (!games.ok) return games;
          if (!gameListed(games.games, gameId)) return refuse('GAME_UNKNOWN', REASONS.GAME_UNKNOWN);
        }
        const rg = online ? rateGate(null, 2) : null;
        if (rg) return rg;
        const base = scriptBase();
        const id = idGen();
        const res = await sidecar.call('open', { session_id: id, game_id: gameId, online: Boolean(online) }, {
          timeoutMs: deadlines.open,
          // Opened after we gave up: close it so it doesn't linger.
          onLate: (reply) => { if (reply.ok) sidecar.call('close', { session_id: id }, { timeoutMs: deadlines.close }); },
        });
        if (!res.ok) return sidecarRefusal(res);
        const { scorecard_id: card, title, obs } = res.result;
        const now = iso();
        const meta = {
          id,
          game_id: res.result.game_id || gameId,
          title,
          mode: online ? 'online' : 'local',
          owner: { sessionId: caller?.sessionId ?? null, project: caller?.project ?? null },
          scorecard_id: card,
          scorecard_url: online ? scorecardUrl(card) : null,
          status: 'live',
          end_reason: null,
          stalled: false,
          created_at: now,
          updated_at: now,
          last_activity_at: now,
          step_count: -1,
          last: lastSummary(obs),
        };
        await store.create(meta);
        rt(id);
        pendingStarts--;
        pendingReleased = true;
        const started = await record(id, 'START', {}, obs, TOOL);
        return { ...started, script: scriptBlock(id, base, access.mint(id)) };
      } finally {
        if (!pendingReleased) pendingStarts--;
      }
    },

    // Runs `apply` (persist the new key) with no live or starting session,
    // then stops the sidecar so the next spawn configures the new key.
    // Refuses SESSIONS_ACTIVE otherwise, KEY_CHANGE_IN_PROGRESS while
    // another change runs.
    async changeKey(apply) {
      if (keyChanging) return refuse('KEY_CHANGE_IN_PROGRESS', 'another API key change is still being saved; try again in a moment');
      if (liveCount() > 0) return refuse('SESSIONS_ACTIVE', 'end the live game sessions before changing the API key');
      keyChanging = true;
      try {
        await apply();
        // The game list depends on the key.
        gamesCache = null;
        sidecar.stop();
        return { ok: true };
      } finally {
        keyChanging = false;
      }
    },

    async act({ session_id: id, action, x, y, reasoning }, caller) {
      const g = gate(id, caller);
      if (g.refusal) return g.refusal;
      if (!ACTIONS.includes(action)) return refuse('INVALID_ARGUMENT', `action must be one of ${ACTIONS.join(', ')}`);
      const hasXY = x !== undefined || y !== undefined;
      if (action === COMPLEX_ACTION) {
        if (![x, y].every((v) => Number.isInteger(v) && v >= 0 && v <= COORD_MAX)) return refuse('INVALID_ARGUMENT', `${COMPLEX_ACTION} needs integer x (column) and y (row), 0-${COORD_MAX}`);
      } else if (hasXY) {
        return refuse('INVALID_ARGUMENT', `only ${COMPLEX_ACTION} takes x and y`);
      }
      if (reasoning !== undefined && (typeof reasoning !== 'string' || reasoning.length > REASONING_MAX_CHARS)) return refuse('INVALID_ARGUMENT', `reasoning must be a string of at most ${REASONING_MAX_CHARS} characters`);
      const { meta, r } = g;
      if (FINISHED.has(meta.last.state)) return refuse('GAME_FINISHED', `the game is in ${meta.last.state}; only reset or end_session`, { state: meta.last.state });
      const n = Number(action.slice(6));
      if (!meta.last.available_actions.includes(n)) return refuse('ACTION_UNAVAILABLE', `${action} is not available now`, { available_actions: meta.last.available_actions.map(actionName) });
      const sg = stepGates(id, meta);
      if (sg) return sg;
      const rg = rateGate(meta, 1);
      if (rg) return rg;
      const args = {};
      if (action === COMPLEX_ACTION) Object.assign(args, { x, y });
      if (reasoning) args.reasoning = reasoning;
      return runStep(id, meta, r, 'step', action, args, { action, ...args }, tagOf(caller));
    },

    async reset({ session_id: id, reasoning }, caller) {
      const g = gate(id, caller);
      if (g.refusal) return g.refusal;
      if (reasoning !== undefined && (typeof reasoning !== 'string' || reasoning.length > REASONING_MAX_CHARS)) return refuse('INVALID_ARGUMENT', `reasoning must be a string of at most ${REASONING_MAX_CHARS} characters`);
      const sg = stepGates(id, g.meta);
      if (sg) return sg;
      const rg = rateGate(g.meta, 1);
      if (rg) return rg;
      // The toolkit's reset takes no reasoning; it is kept for the viewer.
      const args = reasoning ? { reasoning } : {};
      return runStep(id, g.meta, g.r, 'reset', 'RESET', args, {}, tagOf(caller));
    },

    // Open to every tool caller, ended sessions included. A script caller
    // needs its token, and an ended session refuses it like every script call.
    observe({ session_id: id }, caller) {
      if (caller?.script) {
        const a = admit(id, caller);
        if (a.refusal) return a.refusal;
      }
      const meta = store.get(id);
      if (!meta) return refuse('SESSION_UNKNOWN', 'no such session; list_sessions recovers ids');
      return observed(meta);
    },

    // A script starts: its note opens a new run (superseding any other).
    // Returns the observation plus `run`.
    async attach({ session_id: id, note }, caller) {
      const a = admit(id, caller);
      if (a.refusal) return a.refusal;
      const run = await openRun(id, a.meta, note);
      return run.ok ? { ...observed(store.get(id)), run: run.run } : run;
    },

    // The script's plan changed: a new run under the new note.
    async note({ session_id: id, note }, caller) {
      const a = admit(id, caller, { run: true });
      if (a.refusal) return a.refusal;
      return openRun(id, a.meta, note);
    },

    // A fresh script token for the owner (the old one stops working and the
    // current run closes). Stricter than the other tools' collision guard:
    // rotating kills a running script, so the caller must prove it is the
    // owner — a known caller id equal to a known owner id.
    scriptAccess({ session_id: id }, caller) {
      const meta = store.get(id);
      if (!meta) return refuse('SESSION_UNKNOWN', 'no such session; list_sessions recovers ids');
      if (meta.status !== 'live') return refuse('SESSION_ENDED', 'this session has ended', { end_reason: meta.end_reason });
      const owner = meta.owner?.sessionId ?? null;
      if (owner === null) return refuse('NOT_OWNER', 'this session was started by an unidentified caller, so no caller can prove it owns it and its script token cannot be rotated; keep using the token from start_session, or start a new session');
      if (typeof caller?.sessionId !== 'string' || caller.sessionId !== owner) return refuse('NOT_OWNER', 'only the agent session that started this game can rotate its script token');
      return { ok: true, session_id: id, script: scriptBlock(id, scriptBase(), access.mint(id)) };
    },

    async end({ session_id: id }, caller) {
      const g = gate(id, caller, { allowStalled: true });
      if (g.refusal) return g.refusal;
      const meta = store.get(id);
      const rg = rateGate(meta, 1);
      if (rg) return rg;
      const r = rt(id);
      r.inflight = true;
      let res;
      try {
        res = await sidecar.call('close', { session_id: id }, { timeoutMs: deadlines.close });
      } finally {
        r.inflight = false;
      }
      const final = { state: meta.last.state, levels_completed: meta.last.levels_completed, win_levels: meta.last.win_levels, scorecard: res.ok ? res.result.scorecard : null };
      const ended = await end(id, 'ended_by_agent', { final });
      const out = { ok: true, session_id: id, game_id: ended.game_id, steps: ended.step_count, final };
      if (meta.mode === 'online') out.scorecard_url = meta.scorecard_url;
      if (!res.ok) out.warnings = [{ code: PASS_THROUGH.has(res.code) ? res.code : 'TOOLKIT_ERROR', detail: String(res.detail || '').slice(0, DETAIL_MAX), note: 'the session is ended; the scorecard may not have closed cleanly' }];
      return out;
    },

    listSessions({ scope = 'mine' } = {}, caller) {
      const who = caller?.sessionId ?? null;
      const list = store.list().filter((m) => scope === 'all' || (m.owner?.sessionId ?? null) === who).slice(0, LIST_SESSIONS_MAX);
      return {
        ok: true,
        scope,
        sessions: list.map((m) => ({
          session_id: m.id, game_id: m.game_id, title: m.title, mode: m.mode, status: m.status, end_reason: m.end_reason,
          stalled: m.stalled, state: m.last?.state, levels_completed: m.last?.levels_completed, win_levels: m.last?.win_levels,
          step: m.step_count, owner: m.owner, updated_at: m.updated_at, ...(m.mode === 'online' ? { scorecard_url: m.scorecard_url } : {}),
        })),
      };
    },

    // The sidecar died: its environments are gone.
    async onSidecarExit() {
      for (const meta of live()) await end(meta.id, 'sidecar_exit');
    },

    close() {
      timers.clearInterval(sweepTimer);
    },
  };
}
