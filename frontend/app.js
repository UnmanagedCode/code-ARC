// The viewer: session list, frame, replay scrubber, action log and reasoning,
// kept live over SSE. Route state (?session=&step=) lives in the query string.
import { createAnimation } from './animation.js';
import { getJson, subscribe } from './api.js';
import { createGrid } from './grid.js';
import { createNewGame } from './newgame.js';
import { createPlayBar } from './playbar.js';
import { isHumanSession, playable } from './play.js';
import { hasRun, mergeNotes, noteFor, sourceOf } from './runs.js';
import { safeHref } from './safeHref.js';
import { END_REASONS, isNewerThanAll, renderSessions } from './sessions.js';
import { DEFAULT_INTERVAL_MS, INTERVAL_MAX_MS, INTERVAL_MIN_MS, INTERVAL_STEP_MS, createPlayback } from './playback.js';
import { createSettings } from './settings.js';
import { createStepLog } from './steplog.js';

// The newest steps of a session the viewer keeps.
const VIEWER_STEPS_MAX = 5000;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  sessions: new Map(),
  total: 0, // every stored session; `sessions` holds the pages loaded so far
  next: null, // cursor for the next older page, null when all are loaded
  selected: null,
  steps: [],
  notes: [], // the selected session's script run notes
  loadToken: 0,
  // While steps load, live steps wait here and are applied after the load.
  loading: false,
  pending: [],
  renderQueued: false,
  dirtyStep: false, // a queued render needs the whole step view, not only the canvas
  scrubbing: false, // the scrubber's input event is seeking: select without animating
};

// Owns the shown step and the Live/Replay mode; the render is rAF-coalesced.
// onSelect is the only trigger of an animation (never renderStep, which runs
// on every change).
const playback = createPlayback({
  clock: { now: () => performance.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) },
  onChange: () => scheduleRender(),
  onSelect: (i) => onSelected(state.steps[i] ?? null),
});

// Plays the selected step's frames across the interval; fetched on demand, so
// a step without one costs nothing. Its changes redraw only the canvas.
const anim = createAnimation({
  clock: { now: () => performance.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) },
  fetchFrames: (n) => getJson(`api/sessions/${encodeURIComponent(state.selected)}/steps/${n}/frames`),
  onChange: () => scheduleRender(false),
});

// A scrub drag selects without animating or fetching; the settled position animates.
function onSelected(step) {
  anim.select(step, state.scrubbing ? 0 : playback.intervalMs);
  if (!state.scrubbing) anim.prefetch(state.steps[playback.cursor + 1]);
}

const playbar = createPlayBar($('playbar'));
const grid = createGrid($('grid'), $('hover'), { onCell: (c) => playbar.cell(c) });
const log = createStepLog($('steplog'), { onPick: (i) => playback.seek(i), noteOf: (step) => noteFor(state.notes, step) });
createSettings($('settings'), $('settings-toggle'));
createNewGame($('newgame'), $('newgame-toggle'), { onStarted: (id) => select(id) });
document.addEventListener('keydown', (e) => playbar.key(e));

const sortedSessions = () => [...state.sessions.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

function writeRoute() {
  const q = new URLSearchParams();
  if (state.selected) q.set('session', state.selected);
  if (state.selected && playback.mode === 'replay' && playback.cursor >= 0) q.set('step', String(state.steps[playback.cursor]?.n ?? ''));
  const next = q.toString() ? `?${q}` : location.pathname;
  history.replaceState(null, '', next);
}

function renderList() {
  renderSessions($('session-list'), $('sessions-empty'), sortedSessions(), state.selected, (id) => select(id));
  const more = $('sessions-more');
  more.hidden = !state.next;
  more.textContent = `Load older sessions (${Math.max(0, state.total - state.sessions.size)} more)`;
}

function mergePage(page) {
  for (const s of page.sessions) state.sessions.set(s.id, s);
  state.total = page.total;
}

async function loadOlder() {
  if (!state.next) return;
  const page = await getJson(`api/sessions?before=${encodeURIComponent(state.next)}`);
  mergePage(page);
  state.next = page.next;
  renderList();
}

function badge(text, cls) {
  return el('span', `badge ${cls}`, text);
}

function renderHeader() {
  const box = $('game-header');
  const s = state.sessions.get(state.selected);
  if (!s) {
    box.replaceChildren(el('p', 'muted', 'Select a session.'));
    return;
  }
  const step = state.steps[playback.cursor];
  const shown = step || s.last || {};
  const title = el('h2', 'game-title', s.title || s.game_id);
  const facts = el('div', 'facts');
  facts.append(
    el('span', 'fact', `State: ${shown.state ?? '—'}`),
    el('span', 'fact', `Levels: ${shown.levels_completed ?? 0}/${shown.win_levels ?? 0}`),
    el('span', 'fact', `Mode: ${s.mode}`),
    el('span', 'fact muted', s.game_id),
  );
  facts.append(el('span', 'fact', s.allow_reset !== false ? 'Resets: on' : 'Resets: off (one run)'));
  const badges = el('div', 'badges');
  if (isHumanSession(s)) badges.append(badge('Human play', 'owner-human'));
  if (s.status === 'live') badges.append(badge(s.stalled ? 'Stalled: waiting for the toolkit' : 'Live', s.stalled ? 'status-stalled' : 'status-live'));
  else if (s.end_reason === 'scorecard_auto_closed') badges.append(badge('Scorecard auto-closed by arcprize.org (15 min idle)', 'status-warn'));
  else badges.append(badge(END_REASONS[s.end_reason] || 'Ended', 'status-ended'));
  const parts = [title, facts, badges];
  if (s.mode === 'online' && s.scorecard_url) {
    const href = safeHref(s.scorecard_url);
    if (href) {
      const a = el('a', 'scorecard-link', 'Scorecard on arcprize.org');
      a.setAttribute('href', href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      parts.push(a);
    }
  }
  box.replaceChildren(...parts);
}

// The play bar follows the selected session and the Live/Replay view.
function renderPlay() {
  const s = state.sessions.get(state.selected);
  playbar.update(s, { mode: playback.mode, behind: playback.behind });
  document.querySelector('.frame-wrap').classList.toggle('playable', Boolean(playable(s)) && playback.mode === 'live');
}

function renderControls() {
  const { mode, cursor, count, playing, behind } = playback;
  $('mode-live').setAttribute('aria-pressed', String(mode === 'live'));
  $('mode-replay').setAttribute('aria-pressed', String(mode === 'replay'));
  const play = $('play');
  play.textContent = playing ? 'Pause' : 'Play';
  play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  play.disabled = mode === 'live' || count < 2;
  const scrub = $('scrub');
  scrub.max = String(Math.max(0, count - 1));
  scrub.value = String(Math.max(0, cursor));
  scrub.disabled = count < 2;
  $('prev').disabled = cursor <= 0;
  $('next').disabled = cursor >= count - 1;
  $('interval').value = String(playback.intervalMs);
  $('interval-value').textContent = `${playback.intervalMs} ms`;
  const showBehind = mode === 'live' && behind > 0;
  $('behind').hidden = !showBehind;
  $('latest').hidden = !showBehind;
  $('behind').textContent = `${behind} ${behind === 1 ? 'step' : 'steps'} behind`;
  renderPlay();
}

function renderAnim() {
  const box = $('anim');
  box.hidden = !anim.available;
  if (box.hidden) return;
  $('anim-label').textContent = anim.status === 'error' ? 'frames unavailable' : anim.status === 'loading' ? 'loading…' : anim.label;
  $('anim-note').textContent = anim.note;
}

// The canvas and the animation line: all an animation frame changes.
function renderFrame() {
  const step = state.steps[playback.cursor];
  if (!anim.holding) grid.draw(anim.rows() ?? (step ? step.frame : null));
  renderAnim();
}

function renderStep() {
  const step = state.steps[playback.cursor];
  renderFrame();
  renderControls();
  $('scrub-label').textContent = step ? `step ${step.n} of ${state.steps.at(-1).n}` : '';
  if (step) {
    const xy = step.x !== undefined ? ` at (${step.x},${step.y})` : '';
    $('step-summary').textContent = `#${step.n} ${step.action}${xy} · ${sourceOf(step)} · ${new Date(step.ts).toLocaleTimeString()} · ${step.frame_count} frame(s)`;
    renderReasoning(step);
  } else {
    $('step-summary').textContent = '';
    $('reasoning').textContent = '';
  }
  log.select(playback.cursor);
  renderHeader();
  writeRoute();
}

// A script step in a run shows the run's note, then its own reasoning.
function renderReasoning(step) {
  const box = $('reasoning');
  if (sourceOf(step) === 'human') {
    box.textContent = '(human move)';
    return;
  }
  if (!hasRun(step)) {
    box.textContent = step.reasoning || '(no reasoning given)';
    return;
  }
  const note = noteFor(state.notes, step);
  const head = el('div', 'run-note');
  head.append(el('strong', '', `Run ${step.run} note: `), note ? note.text : '(not loaded)');
  box.replaceChildren(head, el('div', 'step-reasoning', step.reasoning || '(no step reasoning)'));
}

// Steps with n >= from; null once the selection moved on.
async function loadSteps(id, token, from) {
  const out = [];
  // Pages at the backend's own page size until an empty page.
  for (;;) {
    const page = (await getJson(`api/sessions/${encodeURIComponent(id)}/steps?from=${from}`)).steps;
    if (token !== state.loadToken) return null;
    if (!page.length) break;
    out.push(...page);
    from = page.at(-1).n + 1;
  }
  return out;
}

async function loadNotes(id, token) {
  const { notes } = await getJson(`api/sessions/${encodeURIComponent(id)}/notes`);
  return token === state.loadToken ? notes : null;
}

// Appends one step (ignoring any already held); past VIEWER_STEPS_MAX the
// oldest row goes, in O(1).
function addStep(step) {
  if (state.steps.length && step.n <= state.steps.at(-1).n) return;
  state.steps.push(step);
  log.append(state.steps);
  playback.append();
  if (state.steps.length > VIEWER_STEPS_MAX) {
    state.steps.shift();
    log.trimFirst(state.steps);
    playback.trim();
  }
}

// One render per display frame however fast steps or animation frames arrive.
// Animation frames (full = false) skip renderStep, which rewrites the URL via
// history.replaceState and would trip the browser's navigation throttling at
// about 60 Hz.
function scheduleRender(full = true) {
  if (full) state.dirtyStep = true;
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    if (state.dirtyStep) {
      state.dirtyStep = false;
      renderStep();
    } else {
      renderFrame();
    }
  });
}

function startLoading() {
  state.loading = true;
  state.pending = [];
}

// Ends a load: applies the live steps that arrived meanwhile.
function finishLoading() {
  state.loading = false;
  const pending = state.pending;
  state.pending = [];
  for (const step of pending) addStep(step);
}

async function select(id, wantStep = null) {
  state.selected = id;
  state.steps = [];
  state.notes = [];
  playback.dispose();
  anim.reset();
  playback.load(0, -1, 'live');
  const token = ++state.loadToken;
  startLoading();
  renderList();
  log.reset([]);
  renderStep();
  const total = Math.max(0, (state.sessions.get(id)?.step_count ?? 0) + 1);
  let steps;
  let notes;
  try {
    [steps, notes] = await Promise.all([loadSteps(id, token, Math.max(0, total - VIEWER_STEPS_MAX)), loadNotes(id, token)]);
  } catch (e) {
    // Keep following live steps from here on.
    if (token === state.loadToken) finishLoading();
    throw e;
  }
  if (!steps || !notes) return;
  state.notes = mergeNotes(notes, state.notes);
  state.steps = steps;
  log.reset(steps);
  let i = state.steps.length - 1;
  if (wantStep !== null) {
    const at = state.steps.findIndex((s) => s.n === wantStep);
    if (at >= 0) i = at;
  }
  // History is shown as recorded, not paced; only later arrivals are.
  playback.load(state.steps.length, i, wantStep === null ? 'live' : 'replay');
  finishLoading();
}

// After a reconnect: fetch only the steps after the last one held, unless
// the gap is past what the viewer keeps (then reload).
async function catchUp() {
  const id = state.selected;
  const last = state.steps.at(-1);
  const behind = (state.sessions.get(id)?.step_count ?? 0) - (last?.n ?? 0);
  if (!last || state.loading || behind > VIEWER_STEPS_MAX) {
    await select(id, playback.mode === 'live' ? null : state.steps[playback.cursor]?.n ?? null);
    return;
  }
  const token = state.loadToken;
  startLoading();
  try {
    const [steps, notes] = await Promise.all([loadSteps(id, token, last.n + 1), loadNotes(id, token)]);
    if (!steps || !notes) return;
    state.notes = mergeNotes(notes, state.notes);
    for (const n of state.notes) log.setNote(n);
    for (const step of steps) addStep(step);
  } finally {
    // A newer selection owns the loading state now.
    if (token === state.loadToken) {
      finishLoading();
      scheduleRender();
    }
  }
}

function onStep({ session_id: id, step }) {
  if (id !== state.selected) return;
  if (state.loading) {
    state.pending.push(step);
    return;
  }
  addStep(step);
  scheduleRender();
}

function onNote({ session_id: id, note }) {
  if (id !== state.selected) return;
  state.notes = mergeNotes(state.notes, [note]);
  log.setNote(note);
  scheduleRender();
}

function onStatus(status) {
  const banner = $('toolkit-banner');
  const tk = status.toolkit || {};
  const source = $('toolkit-source');
  const b = tk.bundle;
  if (tk.source === 'bundle' && b?.id) {
    source.textContent = `Toolkit and local games: bundle ${b.id.slice(0, 12)} (${b.games} games)`;
    source.title = `${b.path}\ncreated ${b.created_at}\ntarget ${Object.values(b.target || {}).filter(Boolean).join(' ')}`;
  } else if (tk.source === 'web') {
    source.textContent = 'Toolkit and games: web';
    source.title = '';
  } else {
    source.textContent = '';
    source.title = '';
  }
  if (tk.state === 'ready') {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.dataset.state = tk.state || 'unknown';
  const rejected = tk.state === 'failed' && tk.code?.startsWith('BUNDLE_');
  const head = rejected ? 'Bundle rejected'
    : { checking: 'Toolkit: checking', installing: 'Toolkit: installing', stopped: 'Toolkit: install stopped', failed: 'Toolkit: install failed', diverged: 'Toolkit: dependencies diverged' }[tk.state] || `Toolkit: ${tk.state}`;
  const parts = [el('strong', '', `${head}${tk.phase && !rejected ? ` (${tk.phase})` : ''}`)];
  if (tk.detail) parts.push(el('pre', 'banner-detail', tk.detail));
  if (tk.fix) parts.push(el('p', 'banner-fix', `Fix: ${tk.fix}`));
  banner.replaceChildren(...parts);
}

function readRoute() {
  const q = new URLSearchParams(location.search);
  const step = q.get('step');
  return { session: q.get('session'), step: step !== null && /^\d+$/.test(step) ? Number(step) : null };
}

async function applyRoute() {
  const r = readRoute();
  if (r.session && !state.sessions.has(r.session)) {
    // A deep link to a session outside the loaded pages.
    try {
      const meta = await getJson(`api/sessions/${encodeURIComponent(r.session)}`);
      state.sessions.set(meta.id, meta);
      renderList();
    } catch { /* unknown id: fall back to the newest */ }
  }
  const target = r.session && state.sessions.has(r.session) ? r.session : sortedSessions()[0]?.id;
  if (!target) return;
  if (target !== state.selected) select(target, r.step);
  else if (r.step !== null) {
    const i = state.steps.findIndex((s) => s.n === r.step);
    if (i >= 0) playback.seek(i);
  }
}

$('sessions-more').addEventListener('click', () => { loadOlder().catch(() => {}); });
$('prev').addEventListener('click', () => playback.seek(playback.cursor - 1));
$('next').addEventListener('click', () => playback.seek(playback.cursor + 1));
// Dragging seeks with a still selection; the release (or each key step) animates.
$('scrub').addEventListener('input', (e) => {
  state.scrubbing = true;
  try { playback.seek(Number(e.target.value)); } finally { state.scrubbing = false; }
});
$('scrub').addEventListener('change', (e) => playback.seek(Number(e.target.value)));
$('mode-live').addEventListener('click', () => playback.setMode('live'));
$('mode-replay').addEventListener('click', () => playback.setMode('replay'));
$('play').addEventListener('click', () => (playback.playing ? playback.pause() : playback.play()));
$('latest').addEventListener('click', () => playback.jumpToLatest());
const slider = $('interval');
slider.min = String(INTERVAL_MIN_MS);
slider.max = String(INTERVAL_MAX_MS);
slider.step = String(INTERVAL_STEP_MS);
slider.value = String(DEFAULT_INTERVAL_MS);
slider.addEventListener('input', (e) => playback.setIntervalMs(Number(e.target.value)));
window.addEventListener('popstate', applyRoute);

let routed = false;
subscribe({
  status: onStatus,
  // The newest page: {sessions, total, next}. On a reconnect it merges, so
  // older pages already loaded stay.
  sessions: (page) => {
    mergePage(page);
    if (!routed) {
      routed = true;
      state.next = page.next;
      renderList();
      applyRoute();
    } else {
      renderList();
      if (state.selected && state.sessions.has(state.selected)) {
        // A reconnect: catch up on anything missed.
        catchUp().catch(() => {});
      }
    }
  },
  session: (meta) => {
    const isNew = !state.sessions.has(meta.id);
    // The server's `total` is the authority: only a session created since
    // that count adds to it; an older unloaded one is already included.
    if (isNew && isNewerThanAll(meta, state.sessions.values())) state.total++;
    state.sessions.set(meta.id, meta);
    renderList();
    if (meta.id === state.selected) {
      renderHeader();
      renderPlay();
    }
    if (isNew && !state.selected) select(meta.id);
  },
  step: onStep,
  note: onNote,
});
