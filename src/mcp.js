// The MCP endpoint's tool handlers. Arguments are re-validated against the
// manifest's own schemas (the single source; cc validates first, but tests and
// any other caller reach the handlers directly), then handed to the session
// service; results are shaped for the agent.
import manifest from '../conductor.plugin.json' with { type: 'json' };
import { frameText } from './frames.js';
import { observationFields } from './observation.js';
import { validate } from './schema.js';
import { refuse } from './sessions.js';

const TOOLS = new Map(manifest.mcp.tools.map((t) => [t.name, t.inputSchema]));

// {text, meta} for a tool that returns an observation.
function observation(r, frameMode) {
  const { text, frame } = frameText(frameMode, r.prev, r.obs.frame);
  const { ok, session_id: sessionId, game_id: gameId, ...rest } = observationFields(r);
  return { text: [text], meta: { ok, session_id: sessionId, game_id: gameId, title: r.meta.title, ...rest, frame } };
}

const asObservation = (r, mode) => (r.ok ? observation(r, mode) : { result: r });

export function createMcp({ sessions, log = console }) {
  const handlers = {
    list_games: async () => ({ result: await sessions.listGames() }),
    // The script block (with its token) rides on start_session's meta only.
    start_session: async (a, caller) => {
      const r = await sessions.start(a, caller);
      const out = asObservation(r, 'full');
      if (r.ok) out.meta.script = r.script;
      return out;
    },
    act: async (a, caller) => asObservation(await sessions.act(a, caller), a.frame),
    reset: async (a, caller) => asObservation(await sessions.reset(a, caller), a.frame),
    observe: async (a) => asObservation(sessions.observe(a), a.frame),
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
