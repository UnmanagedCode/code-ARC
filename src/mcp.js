// The MCP endpoint's tool handlers, serving cc's two typed formats. A request
// is {tool, arguments, caller, format}; `format:'json'` is answered
// {structured} (complete data, validated by cc against the manifest's
// outputSchema), `format:'text'` (or none) {text} (prose, src/toolText.js), and
// a refusal in either {error, code, details?}. Arguments are re-validated
// against the manifest's own schemas (the single source; cc validates first,
// but tests and any other caller reach the handlers directly), then handed to
// the session service. The format also marks who is calling: json is a program
// (cc's run_code goes through the REST alias, which is always json; cc's agents
// connect with ?format=text), so its steps are recorded as scripted. A handler returns a service refusal as-is, or a view
// pair {json, text}: only the requested view is built.
import manifest from '../conductor.plugin.json' with { type: 'json' };
import { IMAGE_SPEC } from './boardImage.js';
import { frameData, frameText } from './frames.js';
import { observationFields } from './observation.js';
import { validate } from './schema.js';
import { refuse } from './sessions.js';
import { endText, gamesText, noteText, observationText, sessionsText } from './toolText.js';

const TOOLS = new Map(manifest.mcp.tools.map((t) => [t.name, t.inputSchema]));

// The refusal body: the service's extras ride in `details`, omitted when empty.
function toError({ reason, code, ok: _ok, ...extra }) {
  const details = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
  return { error: reason, code, ...(Object.keys(details).length ? { details } : {}) };
}

// The json view never carries `ok` (a structured `ok:false` would read as a refusal).
const withoutOk = ({ ok: _ok, ...rest }) => rest;

// The image options apply to frame:'image' only. The manifest gives them no
// default (validate() would fill it in), so a stray one is still visible here.
const misplacedImageOptions = (a) => (a.frame !== 'image' && (a.image_scale !== undefined || a.image_grid !== undefined)
  ? refuse('INVALID_ARGUMENT', "image_scale and image_grid apply to frame:'image' only")
  : null);

export function createMcp({ sessions, images, log = console }) {
  // The image frame ({mode:'image', path | unavailable | error}), or {refusal}.
  // The image is a file the agent opens with Read; the result carries its path,
  // never its bytes. A failed write never fails the call: the action is already
  // recorded.
  async function boardImage(r, a) {
    if (r.meta.status !== 'live') return { refusal: refuse('SESSION_ENDED', 'board images exist only for live sessions; use frame:"full"', { end_reason: r.meta.end_reason }) };
    if (!r.obs.frame) return { frame: { mode: 'image', unavailable: 'no_frame' } };
    const opts = { scale: a.image_scale ?? IMAGE_SPEC.scale.default, grid: a.image_grid ?? IMAGE_SPEC.grid.default };
    try {
      const w = await images.write(r.meta.id, r.meta.step_count, r.obs.frame, opts);
      if (w.ended) return { frame: { mode: 'image', unavailable: 'session_ended' } };
      return { frame: { mode: 'image', path: w.path } };
    } catch (e) {
      log.error(`[code-arc] board image for ${r.meta.id} failed: ${e.stack || e.message}`);
      return { frame: { mode: 'image', error: e.message } };
    }
  }

  // The text view's frame descriptor and labelled grid for a non-image frame.
  function textFrame(a, r) {
    if (a.frame !== 'none' && !r.obs.frame) return { frame: { mode: a.frame, noFrame: true }, grid: '' };
    const ft = frameText(a.frame, r.prev, r.obs.frame);
    return { frame: ft.frame, grid: ft.text };
  }

  // A view pair for a tool that returns an observation, or the refusal.
  async function observation(r, a) {
    if (!r.ok) return r;
    let image = null;
    if (a.frame === 'image') {
      image = await boardImage(r, a);
      if (image.refusal) return image.refusal;
    }
    const { session_id: sessionId, game_id: gameId, ...rest } = withoutOk(observationFields(r));
    const fields = { session_id: sessionId, game_id: gameId, title: r.meta.title, ...rest };
    return {
      json: () => ({ ...fields, frame: image ? image.frame : frameData(a.frame, r.prev, r.obs.frame) }),
      text: () => {
        if (image) return observationText(fields, image.frame);
        const { frame, grid } = textFrame(a, r);
        return observationText(fields, frame, grid);
      },
    };
  }

  const simple = (r, text) => (r.ok ? { json: () => withoutOk(r), text: () => text(withoutOk(r)) } : r);

  const handlers = {
    list_games: async () => simple(await sessions.listGames(), gamesText),
    start_session: async (a, caller) => observation(await sessions.start(a, caller), { frame: 'full' }),
    act: async (a, caller) => misplacedImageOptions(a) || observation(await sessions.act(a, caller), a),
    reset: async (a, caller) => misplacedImageOptions(a) || observation(await sessions.reset(a, caller), a),
    observe: async (a) => misplacedImageOptions(a) || observation(sessions.observe(a), a),
    end_session: async (a, caller) => simple(await sessions.end(a, caller), endText),
    list_sessions: async (a, caller) => simple(sessions.listSessions(a, caller), (r) => sessionsText(r, a.offset ?? 0)),
    note: async (a, caller) => simple(await sessions.note(a, caller), noteText),
  };

  return {
    // The body cc POSTs: {tool, arguments, caller, format}. Always a 200 body.
    // A missing format is answered as text (a plugin that ignores `format` keeps
    // working); any other unknown value is refused.
    async handle(body) {
      if (!body || typeof body !== 'object' || typeof body.tool !== 'string') return { error: 'malformed MCP request: expected {tool, arguments, caller, format}', code: 'INVALID_ARGUMENT' };
      const format = body.format === undefined ? 'text' : body.format;
      if (format !== 'json' && format !== 'text') return { error: "format must be 'json' or 'text'", code: 'INVALID_ARGUMENT' };
      const handler = Object.hasOwn(handlers, body.tool) ? handlers[body.tool] : null;
      const schema = TOOLS.get(body.tool);
      if (!handler || !schema) return { error: `unknown tool '${String(body.tool).slice(0, 64)}'`, code: 'TOOL_UNKNOWN' };
      const v = validate(schema, body.arguments);
      if (v.error) return { error: v.error, code: 'INVALID_ARGUMENT' };
      const c = body.caller && typeof body.caller === 'object' ? body.caller : {};
      const caller = {
        sessionId: typeof c.sessionId === 'string' ? c.sessionId.slice(0, 200) : null,
        project: typeof c.project === 'string' ? c.project.slice(0, 200) : null,
        source: format === 'json' ? 'script' : 'tool',
      };
      try {
        const out = await handler(v.args, caller);
        if (out.ok === false) return toError(out);
        return format === 'json' ? { structured: out.json() } : { text: out.text() };
      } catch (e) {
        log.error(`[code-arc] tool ${body.tool} failed: ${e.stack || e.message}`);
        return { error: `internal error in ${body.tool}`, code: 'INTERNAL' };
      }
    },
    _toolNames: () => Object.keys(handlers),
  };
}
