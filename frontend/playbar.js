// The play controls for a session a person started: action buttons, Reset,
// End, the keyboard and frame clicks. Replay and scrubbing never send: every
// control is off unless the view is Live, and a frame click also needs the
// shown step to be the latest. Requests go one at a time.
import { sendJson } from './api.js';
import { KEY_HINTS, actionForKey, onControl, playable } from './play.js';

const el = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};

const BUTTON_ACTIONS = ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION7'];

export function createPlayBar(container) {
  let meta = null;
  let mode = 'live';
  let behind = 0;
  let busy = false;
  let armed = false; // End waits for a second click
  let message = '';
  let catchingUp = false; // `message` is the transient "Catching up" hint

  const buttons = new Map();
  const actions = el('div', { class: 'play-actions', role: 'group', 'aria-label': 'Actions' });
  for (const a of BUTTON_ACTIONS) {
    const b = el('button', { type: 'button', 'data-action': a }, `${a.replace('ACTION', 'Action ')} (${KEY_HINTS[a]})`);
    b.addEventListener('click', () => act(a));
    buttons.set(a, b);
    actions.append(b);
  }
  const reset = el('button', { type: 'button', 'data-action': 'RESET' }, `Reset (${KEY_HINTS.RESET})`);
  reset.addEventListener('click', () => send('reset', {}));
  const end = el('button', { type: 'button', class: 'play-end' }, 'End');
  end.addEventListener('click', () => {
    if (busy || mode !== 'live') return;
    if (!armed) {
      armed = true;
      render();
      return;
    }
    send('end', {});
  });
  const clickHint = el('span', { class: 'muted' }, 'Click the frame to use ACTION6');
  const hint = el('p', { class: 'play-hint muted' });
  const status = el('p', { class: 'play-message', role: 'status' });
  const row = el('div', { class: 'play-row' });
  row.append(actions, reset, end);
  container.append(row, clickHint, hint, status);

  const current = () => (mode === 'live' ? playable(meta) : null);

  function render() {
    const p = playable(meta);
    container.hidden = !p;
    if (!p) {
      armed = false;
      return;
    }
    const live = mode === 'live';
    if (!live) armed = false;
    for (const [a, b] of buttons) {
      b.disabled = !live || busy || !p.actions.includes(a);
      b.hidden = false;
    }
    reset.hidden = !p.reset;
    reset.disabled = !live || busy;
    end.disabled = !live || busy;
    end.textContent = armed ? 'Confirm end' : 'End';
    clickHint.hidden = !live || !p.actions.includes('ACTION6');
    hint.textContent = live ? '' : 'Replay — switch to Live to play';
    status.textContent = message;
  }

  function refusalText(r) {
    const b = r.body || {};
    let text = b.error ? `${b.error}${b.code ? ` (${b.code})` : ''}` : `Request failed (HTTP ${r.status})`;
    if (Number.isFinite(b.details?.retry_after_ms)) text += `, retry in ${Math.ceil(b.details.retry_after_ms / 1000)} s`;
    return text;
  }

  async function send(path, body) {
    if (busy || !current()) return;
    armed = false;
    busy = true;
    message = '';
    catchingUp = false;
    const id = meta.id;
    render();
    let outcome = '';
    try {
      const r = await sendJson(`api/sessions/${encodeURIComponent(id)}/${path}`, 'POST', body);
      outcome = r.status === 200 ? '' : refusalText(r);
    } catch (e) {
      outcome = `Request failed: ${e.message}`;
    } finally {
      busy = false;
      // A reply for a session no longer selected is never shown under another.
      if (meta?.id === id) message = outcome;
      render();
    }
  }

  const act = (action, xy = {}) => send('act', { action, ...xy });

  return {
    update(nextMeta, view) {
      if (nextMeta?.id !== meta?.id) {
        armed = false;
        message = '';
        catchingUp = false;
      }
      meta = nextMeta;
      mode = view.mode;
      behind = view.behind;
      if (catchingUp && behind === 0) {
        message = '';
        catchingUp = false;
      }
      render();
    },
    // A keydown; handled keys are claimed so the page doesn't scroll and a
    // focused button doesn't also activate on Space.
    key(e) {
      const p = current();
      if (!p) return;
      const action = actionForKey(e);
      if (!action) return;
      const offered = action === 'RESET' ? p.reset : p.actions.includes(action);
      // Claim a key only when it plays, or when it would scroll the page and
      // focus is not on a control.
      if (offered || !onControl(e)) e.preventDefault();
      if (!offered) return;
      if (action === 'RESET') send('reset', {});
      else act(action);
    },
    // A click on the frame: ACTION6 at that cell, only on the current step.
    cell({ x, y }) {
      const p = current();
      if (!p || !p.actions.includes('ACTION6') || busy) return;
      if (behind > 0) {
        message = 'Catching up — click when the frame is current';
        catchingUp = true;
        render();
        return;
      }
      act('ACTION6', { x, y });
    },
  };
}
