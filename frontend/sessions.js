// The session list. Every remote- or agent-written value is set as text.
import { isHumanSession } from './play.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// Self-contained labels, used as-is in the list and the header.
export const END_REASONS = {
  ended_by_agent: 'Ended by agent',
  ended_by_user: 'Ended by user',
  scorecard_auto_closed: 'Scorecard auto-closed',
  sidecar_exit: 'Ended: toolkit exited',
  backend_restart: 'Ended: backend restarted',
};

function ownerLine(owner) {
  if (owner?.kind === 'human') return 'You (Code ARC view)';
  if (!owner || (!owner.sessionId && !owner.project)) return 'unknown caller';
  const parts = [];
  if (owner.sessionId) parts.push(owner.sessionId.length > 12 ? `${owner.sessionId.slice(0, 12)}…` : owner.sessionId);
  if (owner.project) parts.push(owner.project);
  return parts.join(' · ');
}

// Whether `meta` is newer than every loaded session — i.e. created after the
// server counted `total`. An unloaded session that isn't is already counted.
export function isNewerThanAll(meta, loaded) {
  for (const s of loaded) {
    if (s.created_at > meta.created_at || (s.created_at === meta.created_at && s.id >= meta.id)) return false;
  }
  return true;
}

export function renderSessions(listEl, emptyEl, sessions, selectedId, onSelect) {
  emptyEl.hidden = sessions.length > 0;
  const items = sessions.map((s) => {
    const li = el('li', 'session-item');
    const pick = el('button', 'session-pick');
    pick.type = 'button';
    pick.setAttribute('aria-pressed', String(s.id === selectedId));
    pick.addEventListener('click', () => onSelect(s.id));
    const title = el('span', 'session-title', s.title || s.game_id);
    const badges = el('span', 'badges');
    badges.append(el('span', `badge mode-${s.mode}`, s.mode));
    if (isHumanSession(s)) badges.append(el('span', 'badge owner-human', 'human'));
    if (s.max_resets !== 0) badges.append(el('span', 'badge resets', `Resets ${s.resets_used}/${s.max_resets ?? '∞'}`));
    const status = s.status === 'live' ? (s.stalled ? 'Stalled' : 'Live') : END_REASONS[s.end_reason] || 'Ended';
    badges.append(el('span', `badge status-${s.status === 'live' ? (s.stalled ? 'stalled' : 'live') : 'ended'}`, status));
    const meta = el('span', 'session-meta muted', `${s.game_id} · step ${Math.max(0, s.step_count)} · ${s.last?.state ?? ''}`);
    const owner = el('span', 'session-owner muted', ownerLine(s.owner));
    pick.append(title, badges, meta, owner);
    li.append(pick);
    const bridge = window.ccBridge;
    if (bridge && typeof bridge.openSession === 'function' && s.owner?.sessionId) {
      const open = el('button', 'session-open', 'Open session');
      open.type = 'button';
      open.addEventListener('click', async () => {
        const r = await bridge.openSession(s.owner.sessionId);
        open.textContent = r && r.ok ? 'Open session' : `Not live (${r?.code || 'error'})`;
      });
      li.append(open);
    }
    return li;
  });
  listEl.replaceChildren(...items);
}
