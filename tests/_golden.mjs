// The default act/observe outputs on fake-maze, for tests/animation-mcp.test.mjs:
// every frame mode in both formats, with the session id and the data dir
// normalised. `extra` is merged into each act/observe call's arguments.
import { startApp } from './_helpers.mjs';

const FRAMES = ['diff', 'full', 'none', 'image'];
const MOVES = ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION6'];

export async function captureDefaults(t, extra = {}) {
  const { mcp, mcpText, env } = await startApp(t, { stepRate: { max: 1000, windowMs: 1000 } });
  const norm = (v) => JSON.parse(JSON.stringify(v).split(env.dataDir).join('<DATA>').replace(/s-[0-9a-f]{12}/g, '<SID>'));
  const out = {};
  for (const [fmt, call] of [['json', mcp], ['text', mcpText]]) {
    const start = await call('start_session', { game_id: 'fake-maze', max_resets: 1 });
    const sid = start.structured?.session_id || /s-[0-9a-f]{12}/.exec(start.text)[0];
    out[`${fmt}/start`] = norm(start);
    for (const frame of FRAMES) {
      const args = { session_id: sid, action: MOVES[FRAMES.indexOf(frame)], frame, ...(MOVES[FRAMES.indexOf(frame)] === 'ACTION6' ? { x: 5, y: 5 } : {}), ...extra };
      out[`${fmt}/act/${frame}`] = norm(await call('act', args));
    }
    for (const frame of FRAMES.filter((f) => f !== 'diff')) out[`${fmt}/observe/${frame}`] = norm(await call('observe', { session_id: sid, frame, ...extra }));
    out[`${fmt}/reset`] = norm(await call('reset', { session_id: sid }));
  }
  return out;
}
