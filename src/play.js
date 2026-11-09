// The human play routes: the Code ARC view starts and plays its own sessions
// through the same session-service methods the MCP handlers call, so every
// gate and limit applies unchanged. The caller is HUMAN (src/sessions.js).
// A person acts only on sessions they started; the service's `admit` enforces it.
import manifest from '../conductor.plugin.json' with { type: 'json' };
import { HttpError, readJsonBody, sameOriginGuard, sendJson } from './http.js';
import { SESSION_ID_RE } from './limits.js';
import { validate } from './schema.js';
import { HUMAN, refusalBody } from './sessions.js';
import { observationFields } from './observation.js';

const INPUT = new Map(manifest.mcp.tools.map((t) => [t.name, t.inputSchema]));
const KEYS = { start_session: ['game_id', 'online', 'max_resets'], act: ['action', 'x', 'y'], reset: [], end_session: [] };

// A refusal's HTTP status; every code not listed is a state conflict.
const REFUSAL_STATUS = {
  INVALID_ARGUMENT: 400, GAME_UNKNOWN: 400,
  AGENT_SESSION: 403,
  SESSION_UNKNOWN: 404,
  STEP_RATE_LIMITED: 429, RATE_LIMITED: 429,
  TOOLKIT_NOT_READY: 503, TOOLKIT_UNAVAILABLE: 503, DEPS_DIVERGED: 503,
  TOOLKIT_ERROR: 502, TOOLKIT_TIMEOUT: 502, SIDECAR_EXITED: 502, NETWORK_ERROR: 502,
};

// The observation without `ok` and the frame (frames reach the view over SSE
// and step pages), plus the title.
const observationBody = (r) => {
  const { ok: _ok, ...fields } = observationFields(r);
  return { ...fields, title: r.meta.title };
};

// Only the tool's own keys, validated against its manifest schema (the single
// source of the bounds). `reasoning`, `frame` and the like are refused: a
// person's move carries none.
function bodyArgs(tool, body, sessionId) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_ARGUMENT', 'body must be a JSON object');
  for (const k of Object.keys(body)) {
    if (!KEYS[tool].includes(k)) throw new HttpError(400, 'INVALID_ARGUMENT', `unknown argument '${k}'`);
  }
  if (tool === 'reset' || tool === 'end_session') return {};
  const v = validate(INPUT.get(tool), sessionId ? { ...body, session_id: sessionId } : body);
  if (v.error) throw new HttpError(400, 'INVALID_ARGUMENT', v.error);
  return Object.fromEntries(KEYS[tool].filter((k) => v.args[k] !== undefined).map((k) => [k, v.args[k]]));
}

export function createPlayRoutes({ sessions }) {
  const reply = (res, r, ok) => {
    if (r.ok === false) sendJson(res, REFUSAL_STATUS[r.code] ?? 409, refusalBody(r));
    else sendJson(res, 200, ok(r));
  };
  const sessionAction = (suffix, tool, method, ok) => ['POST', new RegExp(`^/api/sessions/(?<id>[^/]+)/${suffix}$`), async (req, res, { params }) => {
    if (!SESSION_ID_RE.test(params.id)) throw new HttpError(404, 'SESSION_UNKNOWN', 'no such session');
    const args = bodyArgs(tool, await readJsonBody(req), params.id);
    reply(res, await sessions[method]({ session_id: params.id, ...args }, HUMAN), ok);
  }];
  return [
    // A GET with side effects (it may start the sidecar and call arcprize.org): same-origin only.
    ['GET', '/api/games', async (req, res) => {
      const blocked = sameOriginGuard(req);
      if (blocked) throw blocked;
      const r = await sessions.listGames();
      reply(res, r, ({ ok: _ok, ...rest }) => rest);
    }],
    ['POST', '/api/sessions', async (req, res) => {
      const args = bodyArgs('start_session', await readJsonBody(req));
      reply(res, await sessions.start(args, HUMAN), observationBody);
    }],
    sessionAction('act', 'act', 'act', observationBody),
    sessionAction('reset', 'reset', 'reset', observationBody),
    sessionAction('end', 'end_session', 'end', ({ ok: _ok, ...rest }) => rest),
  ];
}
