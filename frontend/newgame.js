// The New game panel: pick a game and start it as a session the person plays.
import { getJson, sendJson } from './api.js';

const el = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};

export function createNewGame(panel, toggle, { onStarted }) {
  const heading = el('h2', {}, 'New game');
  const gameLabel = el('label', { for: 'newgame-game' }, 'Game');
  const select = el('select', { id: 'newgame-game' });
  const online = el('input', { id: 'newgame-online', type: 'checkbox' });
  const onlineLabel = el('label', { for: 'newgame-online', class: 'check' });
  onlineLabel.append(online, ' Online (arcprize.org)');
  const onlineNote = el('p', { class: 'muted' }, "Local mode runs the game's code on this machine; online runs it on arcprize.org.");
  const resets = el('input', { id: 'newgame-resets', type: 'checkbox' });
  const resetsLabel = el('label', { for: 'newgame-resets', class: 'check' });
  resetsLabel.append(resets, ' Allow resets');
  const start = el('button', { type: 'button' }, 'Start');
  const notice = el('p', { class: 'muted' });
  const message = el('p', { class: 'newgame-message', role: 'alert' });
  panel.append(heading, gameLabel, select, onlineLabel, onlineNote, resetsLabel, start, notice, message);

  async function load() {
    message.textContent = '';
    try {
      const r = await getJson('api/games');
      select.replaceChildren(...r.games.map((g) => new Option(`${g.title} (${g.game_id})`, g.game_id)));
      notice.textContent = r.web_unavailable ? `Web games unavailable (${r.web_unavailable.code}): only bundled games are listed.` : '';
      start.disabled = r.games.length === 0;
    } catch (e) {
      message.textContent = `Could not load games: ${e.message}`;
      start.disabled = true;
    }
  }

  start.addEventListener('click', async () => {
    if (!select.value) return;
    start.disabled = true;
    message.textContent = '';
    try {
      const r = await sendJson('api/sessions', 'POST', { game_id: select.value, online: online.checked, allow_reset: resets.checked });
      if (r.status === 200) {
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        onStarted(r.body.session_id);
      } else {
        const b = r.body || {};
        const wait = Number.isFinite(b.details?.retry_after_ms) ? `, retry in ${Math.ceil(b.details.retry_after_ms / 1000)} s` : '';
        message.textContent = b.error ? `${b.error} (${b.code})${wait}` : `Failed (HTTP ${r.status})`;
      }
    } catch (e) {
      message.textContent = `Failed: ${e.message}`;
    } finally {
      start.disabled = select.options.length === 0;
    }
  });
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) load();
  });
}
