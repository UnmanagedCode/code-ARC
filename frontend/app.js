// The viewer: session list, frame, replay scrubber, action log and reasoning,
// kept live over SSE. Route state (?session=&step=) lives in the query string.
import { getJson, subscribe } from './api.js';
import { createGrid } from './grid.js';
import { mergeNotes, noteFor, sourceOf } from './runs.js';
import { safeHref } from './safeHref.js';
import { END_REASONS, isNewerThanAll, renderSessions } from './sessions.js';
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
  cursor: -1,
  follow: true,
  loadToken: 0,
  // While steps load, live steps wait here and are applied after the load.
  loading: false,
  pending: [],
  renderQueued: false,
};

const grid = createGrid($('grid'), $('hover'));
const log = createStepLog($('steplog'), { onPick: (i) => setCursor(i, { manual: true }), noteOf: (step) => noteFor(state.notes, step) });
createSettings($('settings'), $('settings-toggle'));

const sortedSessions = () => [...state.sessions.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

function writeRoute() {
  const q = new URLSearchParams();
  if (state.selected) q.set('session', state.selected);
  if (state.selected && !state.follow && state.cursor >= 0) q.set('step', String(state.steps[state.cursor]?.n ?? ''));
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
  const step = state.steps[state.cursor];
  const shown = step || s.last || {};
  const title = el('h2', 'game-title', s.title || s.game_id);
  const facts = el('div', 'facts');
  facts.append(
    el('span', 'fact', `State: ${shown.state ?? '—'}`),
    el('span', 'fact', `Levels: ${shown.levels_completed ?? 0}/${shown.win_levels ?? 0}`),
    el('span', 'fact', `Mode: ${s.mode}`),
    el('span', 'fact muted', s.game_id),
  );
  const badges = el('div', 'badges');
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

function renderStep() {
  const step = state.steps[state.cursor];
  grid.draw(step ? step.frame : null);
  const scrub = $('scrub');
  scrub.max = String(Math.max(0, state.steps.length - 1));
  scrub.value = String(Math.max(0, state.cursor));
  scrub.disabled = state.steps.length < 2;
  $('prev').disabled = state.cursor <= 0;
  $('next').disabled = state.cursor >= state.steps.length - 1;
  $('scrub-label').textContent = step ? `step ${step.n} of ${state.steps.at(-1).n}` : '';
  $('follow').checked = state.follow;
  if (step) {
    const xy = step.x !== undefined ? ` at (${step.x},${step.y})` : '';
    $('step-summary').textContent = `#${step.n} ${step.action}${xy} · ${sourceOf(step)} · ${new Date(step.ts).toLocaleTimeString()} · ${step.frame_count} frame(s)`;
    renderReasoning(step);
  } else {
    $('step-summary').textContent = '';
    $('reasoning').textContent = '';
  }
  log.select(state.cursor);
  renderHeader();
}

// A script step shows its run's note, then its own reasoning.
function renderReasoning(step) {
  const box = $('reasoning');
  if (sourceOf(step) !== 'script') {
    box.textContent = step.reasoning || '(no reasoning given)';
    return;
  }
  const note = noteFor(state.notes, step);
  const head = el('div', 'run-note');
  head.append(el('strong', '', `Run ${step.run} note: `), note ? note.text : '(not loaded)');
  box.replaceChildren(head, el('div', 'step-reasoning', step.reasoning || '(no step reasoning)'));
}

function setCursor(i, { manual = false } = {}) {
  if (!state.steps.length) return;
  state.cursor = Math.max(0, Math.min(state.steps.length - 1, i));
  if (manual) state.follow = state.cursor === state.steps.length - 1 && state.follow;
  renderStep();
  writeRoute();
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
  if (state.steps.length > VIEWER_STEPS_MAX) {
    state.steps.shift();
    log.trimFirst(state.steps);
    state.cursor = Math.max(0, state.cursor - 1);
  }
}

// One render per animation frame however fast steps arrive.
function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    if (state.follow) setCursor(state.steps.length - 1);
    else renderStep();
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
  state.cursor = -1;
  state.follow = wantStep === null;
  const token = ++state.loadToken;
  startLoading();
  renderList();
  log.reset([]);
  renderStep();
  writeRoute();
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
  finishLoading();
  let i = state.steps.length - 1;
  if (wantStep !== null) {
    const at = state.steps.findIndex((s) => s.n === wantStep);
    if (at >= 0) i = at;
  }
  setCursor(i);
}

// After a reconnect: fetch only the steps after the last one held, unless
// the gap is past what the viewer keeps (then reload).
async function catchUp() {
  const id = state.selected;
  const last = state.steps.at(-1);
  const behind = (state.sessions.get(id)?.step_count ?? 0) - (last?.n ?? 0);
  if (!last || state.loading || behind > VIEWER_STEPS_MAX) {
    await select(id, state.follow ? null : state.steps[state.cursor]?.n ?? null);
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
  if (tk.state === 'ready') {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.dataset.state = tk.state || 'unknown';
  const head = { checking: 'Toolkit: checking', installing: 'Toolkit: installing', stopped: 'Toolkit: install stopped', failed: 'Toolkit: install failed', diverged: 'Toolkit: dependencies diverged' }[tk.state] || `Toolkit: ${tk.state}`;
  const parts = [el('strong', '', `${head}${tk.phase ? ` (${tk.phase})` : ''}`)];
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
    if (i >= 0) {
      state.follow = false;
      setCursor(i);
    }
  }
}

$('sessions-more').addEventListener('click', () => { loadOlder().catch(() => {}); });
$('prev').addEventListener('click', () => { state.follow = false; setCursor(state.cursor - 1); });
$('next').addEventListener('click', () => setCursor(state.cursor + 1, { manual: true }));
$('scrub').addEventListener('input', (e) => { state.follow = false; setCursor(Number(e.target.value)); });
$('follow').addEventListener('change', (e) => {
  state.follow = e.target.checked;
  if (state.follow) setCursor(state.steps.length - 1);
  else writeRoute();
});
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
    if (meta.id === state.selected) renderHeader();
    if (isNew && !state.selected) select(meta.id);
  },
  step: onStep,
  note: onNote,
});
