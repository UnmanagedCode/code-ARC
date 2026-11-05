// The viewer: session list, frame, replay scrubber, action log and reasoning,
// kept live over SSE. Route state (?session=&step=) lives in the query string.
import { getJson, subscribe } from './api.js';
import { createGrid } from './grid.js';
import { safeHref } from './safeHref.js';
import { END_REASONS, renderSessions } from './sessions.js';
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
  selected: null,
  steps: [],
  cursor: -1,
  follow: true,
  loadToken: 0,
};

const grid = createGrid($('grid'), $('hover'));
const log = createStepLog($('steplog'), (i) => setCursor(i, { manual: true }));
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
    $('step-summary').textContent = `#${step.n} ${step.action}${xy} · ${new Date(step.ts).toLocaleTimeString()} · ${step.frame_count} frame(s)`;
    $('reasoning').textContent = step.reasoning || '(no reasoning given)';
  } else {
    $('step-summary').textContent = '';
    $('reasoning').textContent = '';
  }
  log.select(state.cursor);
  renderHeader();
}

function setCursor(i, { manual = false } = {}) {
  if (!state.steps.length) return;
  state.cursor = Math.max(0, Math.min(state.steps.length - 1, i));
  if (manual) state.follow = state.cursor === state.steps.length - 1 && state.follow;
  renderStep();
  writeRoute();
}

async function loadSteps(id, token) {
  const s = state.sessions.get(id);
  const total = Math.max(0, (s?.step_count ?? 0) + 1);
  let from = Math.max(0, total - VIEWER_STEPS_MAX);
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

async function select(id, wantStep = null) {
  state.selected = id;
  state.steps = [];
  state.cursor = -1;
  state.follow = wantStep === null;
  const token = ++state.loadToken;
  renderList();
  log.reset([]);
  renderStep();
  writeRoute();
  const steps = await loadSteps(id, token);
  if (!steps) return;
  state.steps = steps;
  log.reset(steps);
  let i = steps.length - 1;
  if (wantStep !== null) {
    const at = steps.findIndex((s) => s.n === wantStep);
    if (at >= 0) i = at;
  }
  setCursor(i);
}

function onStep({ session_id: id, step }) {
  if (id !== state.selected) return;
  if (state.steps.length && step.n <= state.steps.at(-1).n) return;
  state.steps.push(step);
  if (state.steps.length > VIEWER_STEPS_MAX) {
    state.steps.shift();
    log.reset(state.steps);
    state.cursor = Math.max(0, state.cursor - 1);
  } else {
    log.append(step, state.steps.length - 1);
  }
  if (state.follow) setCursor(state.steps.length - 1);
  else renderStep();
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

function applyRoute() {
  const r = readRoute();
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
  sessions: (list) => {
    state.sessions = new Map(list.map((s) => [s.id, s]));
    renderList();
    if (!routed) {
      routed = true;
      applyRoute();
    } else if (state.selected && state.sessions.has(state.selected)) {
      // A reconnect: catch up on anything missed.
      select(state.selected, state.follow ? null : state.steps[state.cursor]?.n ?? null);
    }
  },
  session: (meta) => {
    const isNew = !state.sessions.has(meta.id);
    state.sessions.set(meta.id, meta);
    renderList();
    if (meta.id === state.selected) renderHeader();
    if (isNew && !state.selected) select(meta.id);
  },
  step: onStep,
});
