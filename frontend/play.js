// Human play, pure (no DOM): which sessions a person may play, which actions
// the controls offer, and what a key means. The server stays the authority;
// this is only the controls' hint, and a mismatch shows as a refusal.

const FINISHED_STATES = new Set(['WIN', 'GAME_OVER']);

// A meta without owner.kind is a legacy (agent) session.
export const isHumanSession = (meta) => meta?.owner?.kind === 'human';

// null unless the selected session is a live human one; else
// {actions: ['ACTION1', …] (RESET and ACTION6's hint included only as offered), reset}.
export function playable(meta) {
  if (!isHumanSession(meta) || meta.status !== 'live') return null;
  const last = meta.last || {};
  const finished = FINISHED_STATES.has(last.state);
  const actions = finished ? [] : (last.available_actions || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7).map((n) => `ACTION${n}`);
  return { actions, reset: meta.allow_reset !== false };
}

// Button labels: the key that sends each action.
export const KEY_HINTS = Object.freeze({ ACTION1: '↑ / W', ACTION2: '↓ / S', ACTION3: '← / A', ACTION4: '→ / D', ACTION5: 'Space', ACTION7: 'Z', RESET: 'R' });

const KEYS = { arrowup: 'ACTION1', w: 'ACTION1', arrowdown: 'ACTION2', s: 'ACTION2', arrowleft: 'ACTION3', a: 'ACTION3', arrowright: 'ACTION4', d: 'ACTION4', ' ': 'ACTION5', z: 'ACTION7', r: 'RESET' };

// The action a keydown means, or null. One press is one action (a held key's
// repeats are ignored, keeping it off the step budget); modified presses and
// typing into a form control are not play.
export function actionForKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return null;
  return KEYS[String(e.key).toLowerCase()] ?? null;
}
