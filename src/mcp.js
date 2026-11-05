// The MCP endpoint's tool handlers. Arguments are re-validated against the
// manifest's own schemas (the single source; cc validates first, but tests and
// any other caller reach the handlers directly), then handed to the session
// service; results are shaped for the agent.
import manifest from '../conductor.plugin.json' with { type: 'json' };
import { frameText } from './frames.js';
import { actionName, refuse } from './sessions.js';

const TOOLS = new Map(manifest.mcp.tools.map((t) => [t.name, t.inputSchema]));

// Validates `args` against a manifest inputSchema (the flat subset cc allows)
// and fills defaults. Returns {args} or {error}.
export function validate(schema, input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'arguments must be an object' };
  const props = schema.properties || {};
  const out = {};
  for (const k of Object.keys(input)) if (!(k in props)) return { error: `unknown argument '${k}'` };
  for (const k of schema.required || []) if (input[k] === undefined) return { error: `missing required argument '${k}'` };
  for (const [k, spec] of Object.entries(props)) {
    let v = input[k];
    if (v === undefined) {
      if (spec.default !== undefined) out[k] = spec.default;
      continue;
    }
    const ok = spec.type === 'integer' ? Number.isInteger(v) : spec.type === 'boolean' ? typeof v === 'boolean' : typeof v === spec.type;
    if (!ok) return { error: `'${k}' must be ${spec.type === 'integer' ? 'an integer' : `a ${spec.type}`}` };
    if (spec.enum && !spec.enum.includes(v)) return { error: `'${k}' must be one of ${spec.enum.join(', ')}` };
    if (spec.minimum !== undefined && v < spec.minimum) return { error: `'${k}' must be >= ${spec.minimum}` };
    if (spec.maximum !== undefined && v > spec.maximum) return { error: `'${k}' must be <= ${spec.maximum}` };
    if (spec.maxLength !== undefined && v.length > spec.maxLength) return { error: `'${k}' must be at most ${spec.maxLength} characters` };
    if (spec.minLength !== undefined && v.length < spec.minLength) return { error: `'${k}' must be at least ${spec.minLength} characters` };
    if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(v)) return { error: `'${k}' is malformed` };
    out[k] = v;
  }
  return { args: out };
}

// {text, meta} for a tool that returns an observation.
function observation(r, frameMode) {
  const { meta: s, obs, prev, online } = r;
  const { text, frame } = frameText(frameMode, prev, obs.frame);
  const meta = {
    ok: true,
    session_id: s.id,
    game_id: s.game_id,
    title: s.title,
    mode: s.mode,
    status: s.status,
    state: obs.state,
    levels_completed: obs.levels_completed,
    win_levels: obs.win_levels,
    available_actions: (obs.available_actions || []).map(actionName),
    step: s.step_count,
    frame_count: obs.frame_count,
    full_reset: obs.full_reset,
    frame,
  };
  if (s.status !== 'live') meta.end_reason = s.end_reason;
  if (online) meta.online = online;
  return { text: [text], meta };
}

const asObservation = (r, mode) => (r.ok ? observation(r, mode) : { result: r });

export function createMcp({ sessions, log = console }) {
  const handlers = {
    list_games: async () => ({ result: await sessions.listGames() }),
    start_session: async (a, caller) => asObservation(await sessions.start(a, caller), 'full'),
    act: async (a, caller) => asObservation(await sessions.act(a, caller), a.frame),
    reset: async (a, caller) => asObservation(await sessions.reset(a, caller), a.frame),
    observe: async (a) => asObservation(sessions.observe(a), a.frame),
    end_session: async (a, caller) => ({ result: await sessions.end(a, caller) }),
    list_sessions: async (a, caller) => ({ result: sessions.listSessions(a, caller) }),
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
