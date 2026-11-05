// The Settings panel: the ARC API key, shown only masked.
import { getJson, sendJson } from './api.js';

const el = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};

export function createSettings(panel, toggle) {
  const heading = el('h2', {}, 'Settings');
  const label = el('label', { for: 'api-key' }, 'ARC API key');
  const input = el('input', { id: 'api-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'paste a key from arcprize.org' });
  const save = el('button', { type: 'button' }, 'Save');
  const clear = el('button', { type: 'button' }, 'Clear');
  const status = el('p', { class: 'key-status', 'aria-live': 'polite' });
  const message = el('p', { class: 'key-message', role: 'alert' });
  const note = el('p', { class: 'muted' }, "Empty = toolkit's anonymous key. The key is stored in the plugin's data dir and never shown again in full. Changing it needs all game sessions ended.");
  const row = el('div', { class: 'key-row' });
  row.append(input, save, clear);
  panel.append(heading, label, row, status, message, note);

  const show = (apiKey) => { status.textContent = apiKey.set ? `Key set: ${apiKey.masked}` : 'No key set (anonymous)'; };
  // The server's reason says what to do (end sessions, wait for another save, …).
  const fail = (r) => {
    message.textContent = (r.body && r.body.error) || `Failed (HTTP ${r.status})`;
  };

  async function refresh() {
    try {
      show((await getJson('api/settings')).apiKey);
    } catch (e) {
      status.textContent = `Could not load settings: ${e.message}`;
    }
  }

  async function apply(method, body) {
    message.textContent = '';
    const r = await sendJson('api/settings/api-key', method, body);
    if (r.status === 200) {
      input.value = '';
      show(r.body.apiKey);
    } else {
      fail(r);
    }
  }

  save.addEventListener('click', () => apply('PUT', { key: input.value }));
  clear.addEventListener('click', () => apply('DELETE', {}));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply('PUT', { key: input.value }); });
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) refresh();
  });
}
