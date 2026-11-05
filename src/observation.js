// The observation fields both surfaces return for a session service result
// {meta, obs, online}: the MCP tools add the title and the frame text, the
// script routes add the raw frame rows.
import { actionName } from './sessions.js';

export function observationFields({ meta: s, obs, online }) {
  const out = {
    ok: true,
    session_id: s.id,
    game_id: s.game_id,
    mode: s.mode,
    status: s.status,
    state: obs.state,
    levels_completed: obs.levels_completed,
    win_levels: obs.win_levels,
    available_actions: (obs.available_actions || []).map(actionName),
    step: s.step_count,
    frame_count: obs.frame_count,
    full_reset: obs.full_reset,
  };
  if (s.status !== 'live') out.end_reason = s.end_reason;
  if (online) out.online = online;
  return out;
}
