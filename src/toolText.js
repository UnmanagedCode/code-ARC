// The text view of the tool results: prose for an agent reading a transcript.
// Plain functions of the json data (the structured view is the complete data;
// these never drop any of it, except list_sessions' page). Field names appear
// verbatim so an agent's vocabulary is the same in both views. The labelled
// frame grid is src/frames.js's text, passed in as-is.
import { LIST_SESSIONS_TEXT_PAGE } from './limits.js';

const list = (xs) => (xs.length ? xs.join(', ') : 'none');

function frameLine(f) {
  if (f.mode === 'none') return null;
  if (f.mode === 'image') {
    if (f.path) return `Board image: ${f.path}, open it with Read.`;
    if (f.error !== undefined) return `No image: it could not be written (error: ${f.error}). The action still happened.`;
    return f.unavailable === 'session_ended' ? 'No image: the session ended during the call.' : 'No image: no frame stored.';
  }
  if (f.noFrame) return 'No frame stored.';
  if (f.mode === 'diff') {
    if (f.changed_cells === 0) return 'Frame diff: no cells changed.';
    const b = f.bbox;
    return `Frame diff: ${f.changed_cells} changed_cells, bbox x ${b.x0}–${b.x1}, y ${b.y0}–${b.y1}.`;
  }
  return f.auto_full ? 'Frame full (auto_full: the diff was too large or had no previous frame).' : 'Frame full.';
}

// `o` is the observation json without `frame`; `frame` describes what was
// rendered ({mode, auto_full?, changed_cells?, bbox?, noFrame?} or the image
// frame) and `grid` is the labelled frame text ('' when none).
export function observationText(o, frame, grid = '') {
  const lines = [
    `Session ${o.session_id}: ${o.game_id} "${o.title}" (${o.mode}, ${o.status})`,
    `state ${o.state} · levels_completed ${o.levels_completed}/${o.win_levels} · step ${o.step}`,
    `available_actions: ${list(o.available_actions)}`,
  ];
  if (o.max_resets === 0) lines.push('max_resets 0 (one run; reset is refused)');
  else if (o.max_resets === null) lines.push(`max_resets unlimited (legacy session) · resets_used ${o.resets_used}`);
  else lines.push(`max_resets ${o.max_resets} · resets_used ${o.resets_used} · resets_remaining ${o.resets_remaining}`);
  if (o.full_reset) lines.push('full_reset: the whole game restarted');
  if (o.status === 'ended') lines.push(`status ended (end_reason ${o.end_reason})`);
  if (o.online) lines.push(`online: scorecard_url ${o.online.scorecard_url} · idle_close_at ${o.online.idle_close_at}`);
  lines.push(o.frame_count > 1 ? `frame_count ${o.frame_count}: the action animated; this is the last frame.` : `frame_count ${o.frame_count}.`);
  const fl = frameLine(frame);
  if (fl) lines.push(fl);
  if (grid && !(frame.mode === 'diff' && frame.changed_cells === 0)) lines.push(grid);
  return lines.join('\n');
}

export function gamesText({ games, web_unavailable: gap }) {
  const lines = [games.length ? `${games.length} games:` : 'No games are available.'];
  for (const g of games) {
    const tags = g.tags.length ? ` tags: ${g.tags.join(', ')}` : '';
    lines.push(`- ${g.game_id} "${g.title}" (source ${g.source}${g.downloaded ? ', downloaded' : ''})${tags}`);
  }
  if (gap) lines.push(`Only the offline bundle's games are listed: the web game list is unavailable (${gap.code}: ${gap.detail}).`);
  return lines.join('\n');
}

function scorecardLines(sc) {
  if (!sc) return ['scorecard: none returned'];
  const out = [`scorecard: card_id ${sc.card_id} · score ${sc.score} · total_levels_completed ${sc.total_levels_completed}/${sc.total_levels} · total_actions ${sc.total_actions}`];
  for (const e of sc.environments || []) {
    out.push(`  - ${e.id}: score ${e.score} · levels_completed ${e.levels_completed}/${e.level_count} · actions ${e.actions} · resets ${e.resets} · completed ${e.completed}`);
  }
  return out;
}

export function endText(r) {
  const f = r.final;
  const lines = [
    `Ended session ${r.session_id} (${r.game_id}) after ${r.steps} steps. final: state ${f.state} · levels_completed ${f.levels_completed}/${f.win_levels}.`,
    ...scorecardLines(f.scorecard),
  ];
  if (r.scorecard_url) lines.push(`scorecard_url ${r.scorecard_url}`);
  for (const w of r.warnings || []) lines.push(`warning ${w.code}: ${w.detail} — ${w.note}`);
  return lines.join('\n');
}

export function noteText(r) {
  return `Run ${r.run} opened on ${r.session_id}: steps a run_code program takes show under this note until the next one.`;
}

// One page of LIST_SESSIONS_TEXT_PAGE from `r.sessions` (already starting at
// `offset`); says how to reach the rest.
export function sessionsText(r, offset = 0) {
  const { scope, total, sessions } = r;
  if (sessions.length === 0) {
    return offset > 0 ? `No sessions at offset ${offset} (${total} in scope ${scope}).` : `No sessions (scope ${scope}).`;
  }
  const page = sessions.slice(0, LIST_SESSIONS_TEXT_PAGE);
  const lines = [`Sessions (scope ${scope}), newest first: ${offset + 1}–${offset + page.length} of ${total}.`];
  for (const s of page) {
    const parts = [`- ${s.session_id} ${s.game_id} "${s.title}"`, s.mode, s.status];
    if (s.stalled) parts.push('stalled');
    if (s.max_resets === null) parts.push('max_resets unlimited');
    else if (s.max_resets > 0) parts.push(`resets ${s.resets_used}/${s.max_resets}`);
    if (s.end_reason) parts.push(`end_reason ${s.end_reason}`);
    if (s.state !== undefined) parts.push(`state ${s.state} · levels_completed ${s.levels_completed}/${s.win_levels}`);
    parts.push(`step ${s.step}`);
    if (scope === 'all' && s.owner?.kind === 'human') parts.push('owner human (Code ARC view)');
    else if (scope === 'all' && s.owner?.sessionId) parts.push(`owner ${s.owner.sessionId}`);
    if (s.scorecard_url) parts.push(`scorecard_url ${s.scorecard_url}`);
    parts.push(`updated ${s.updated_at}`);
    lines.push(parts.join(' · '));
  }
  const rest = total - offset - page.length;
  if (rest > 0) lines.push(`${rest} more not shown: call list_sessions with offset: ${offset + page.length}.`);
  return lines.join('\n');
}
