// The MCP endpoint's tool handlers. Arguments are re-validated against the
// manifest's own schemas (the single source; cc validates first, but tests and
// any other caller reach the handlers directly), then handed to the session
// service; results are shaped for the agent.
import manifest from '../conductor.plugin.json' with { type: 'json' };
import { IMAGE_SPEC } from './boardImage.js';
import { frameText } from './frames.js';
import { observationFields } from './observation.js';
import { validate } from './schema.js';
import { refuse } from './sessions.js';

const TOOLS = new Map(manifest.mcp.tools.map((t) => [t.name, t.inputSchema]));

// The image options apply to frame:'image' only. The manifest gives them no
// default (validate() would fill it in), so a stray one is still visible here.
const misplacedImageOptions = (a) => (a.frame !== 'image' && (a.image_scale !== undefined || a.image_grid !== undefined)
  ? { result: refuse('INVALID_ARGUMENT', "image_scale and image_grid apply to frame:'image' only") }
  : null);

export function createMcp({ sessions, images, log = console }) {
  // {text, frame} for frame:'image', or {refusal}. The image is a file the
  // agent opens with Read; the result carries its path, never its bytes. A
  // failed write never fails the call: the action is already recorded.
  async function boardImage(r, a) {
    if (r.meta.status !== 'live') return { refusal: refuse('SESSION_ENDED', 'board images exist only for live sessions; use frame:"full"', { end_reason: r.meta.end_reason }) };
    if (!r.obs.frame) return { text: 'no frame', frame: { mode: 'image' } };
    const opts = { scale: a.image_scale ?? IMAGE_SPEC.scale.default, grid: a.image_grid ?? IMAGE_SPEC.grid.default };
    try {
      const w = await images.write(r.meta.id, r.meta.step_count, r.obs.frame, opts);
      if (w.ended) return { text: 'no image: the session ended', frame: { mode: 'image' } };
      return { text: '', frame: { mode: 'image', path: w.path } };
    } catch (e) {
      log.error(`[code-arc] board image for ${r.meta.id} failed: ${e.stack || e.message}`);
      return { text: 'no image: it could not be written (meta.frame.error)', frame: { mode: 'image', error: e.message } };
    }
  }

  // {text, meta} for a tool that returns an observation, or {result} for a refusal.
  async function observation(r, a) {
    if (!r.ok) return { result: r };
    let text;
    let frame;
    if (a.frame === 'image') {
      const img = await boardImage(r, a);
      if (img.refusal) return { result: img.refusal };
      ({ text, frame } = img);
    } else {
      ({ text, frame } = frameText(a.frame, r.prev, r.obs.frame));
    }
    const { ok, session_id: sessionId, game_id: gameId, ...rest } = observationFields(r);
    return { text: [text], meta: { ok, session_id: sessionId, game_id: gameId, title: r.meta.title, ...rest, frame } };
  }

  const handlers = {
    list_games: async () => ({ result: await sessions.listGames() }),
    // The script block (with its token) rides on start_session's meta only.
    start_session: async (a, caller) => {
      const r = await sessions.start(a, caller);
      const out = await observation(r, { frame: 'full' });
      if (r.ok) out.meta.script = r.script;
      return out;
    },
    act: async (a, caller) => misplacedImageOptions(a) || observation(await sessions.act(a, caller), a),
    reset: async (a, caller) => misplacedImageOptions(a) || observation(await sessions.reset(a, caller), a),
    observe: async (a) => misplacedImageOptions(a) || observation(sessions.observe(a), a),
    end_session: async (a, caller) => ({ result: await sessions.end(a, caller) }),
    list_sessions: async (a, caller) => ({ result: sessions.listSessions(a, caller) }),
    script_access: async (a, caller) => ({ result: sessions.scriptAccess(a, caller) }),
  };

  return {
    // The body cc POSTs: {tool, arguments, caller}. Always a 200 body.
    async handle(body) {
      if (!body || typeof body !== 'object' || typeof body.tool !== 'string') return { error: 'malformed MCP request: expected {tool, arguments, caller}' };
      const handler = Object.hasOwn(handlers, body.tool) ? handlers[body.tool] : null;
      const schema = TOOLS.get(body.tool);
      if (!handler || !schema) return { error: `unknown tool '${String(body.tool).slice(0, 64)}'` };
      const v = validate(schema, body.arguments);
      if (v.error) return { result: refuse('INVALID_ARGUMENT', v.error) };
      const c = body.caller && typeof body.caller === 'object' ? body.caller : {};
      const caller = {
        sessionId: typeof c.sessionId === 'string' ? c.sessionId.slice(0, 200) : null,
        project: typeof c.project === 'string' ? c.project.slice(0, 200) : null,
      };
      try {
        return await handler(v.args, caller);
      } catch (e) {
        log.error(`[code-arc] tool ${body.tool} failed: ${e.stack || e.message}`);
        return { error: `internal error in ${body.tool}` };
      }
    },
    _toolNames: () => Object.keys(handlers),
  };
}
