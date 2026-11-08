// The observation fields every observation-returning tool shares, for a session
// service result {meta, obs, online}; src/mcp.js adds the title and the frame.
import { actionName, visibleActions } from './sessions.js';

export function observationFields({ meta: s, obs, online }) {
  const out = {
    ok: true,
    session_id: s.id,
    game_id: s.game_id,
    mode: s.mode,
    ...(s.allow_reset === false ? { allow_reset: false } : {}),
    status: s.status,
    state: obs.state,
    levels_completed: obs.levels_completed,
    win_levels: obs.win_levels,
    available_actions: visibleActions(s, obs).map(actionName),
    step: s.step_count,
    frame_count: obs.frame_count,
    full_reset: obs.full_reset,
  };
  if (s.status !== 'live') out.end_reason = s.end_reason;
  if (online) out.online = online;
  return out;
}
