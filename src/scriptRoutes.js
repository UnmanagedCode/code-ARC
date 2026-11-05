// The script HTTP API (`POST api/play/:id/<op>`, docs/protocol.md → Script
// HTTP API): the same session service as the MCP tools, reached by a
// non-browser client with a bearer token. Never logs headers; the token is
// never in the URL.
import { HttpError, readJsonBody, sendJson } from './http.js';
import { ACTIONS, COORD_MAX, NOTE_MAX_CHARS, REASONING_MAX_CHARS, SCRIPT_AUTH_HEADER_MAX, SESSION_ID_RE } from './limits.js';
import { observationFields } from './observation.js';
import { validate } from './schema.js';
import { refuse } from './sessions.js';

const ROUTE = /^\/api\/play\/(?<id>[^/]+)\/(?<op>attach|act|reset|note|observe)$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{1,128})$/;

const run = { type: 'integer', minimum: 1 };
const note = { type: 'string', minLength: 1, maxLength: NOTE_MAX_CHARS };
const reasoning = { type: 'string', maxLength: REASONING_MAX_CHARS };
const coord = { type: 'integer', minimum: 0, maximum: COORD_MAX };
const SCHEMAS = {
  attach: { properties: { note }, required: ['note'] },
  act: { properties: { run, action: { type: 'string', enum: [...ACTIONS] }, x: coord, y: coord, reasoning }, required: ['run', 'action'] },
  reset: { properties: { run, reasoning }, required: ['run'] },
  note: { properties: { run, note }, required: ['run', 'note'] },
  observe: { properties: {} },
};

// Browsers always send Sec-Fetch-Site (and usually Origin); scripts send
// neither. Refusing both keeps even the same-origin viewer out.
function scriptGuard(req) {
  if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
    throw new HttpError(403, 'CROSS_SITE', 'script routes are for non-browser clients');
  }
}

// The presented token, or null (missing, malformed, over-long).
function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || h.length > SCRIPT_AUTH_HEADER_MAX) return null;
  return BEARER.exec(h)?.[1] ?? null;
}

const scriptObservation = (r, extra = {}) => ({ ...observationFields(r), frame: r.obs.frame ?? null, ...extra });

export function scriptRoutes({ sessions }) {
  const ops = {
    attach: async (sid, a, caller) => {
      const r = await sessions.attach({ session_id: sid, note: a.note }, caller);
      return r.ok ? scriptObservation(r, { run: r.run }) : r;
    },
    act: async (sid, a, caller) => {
      const { run: _run, ...args } = a;
      const r = await sessions.act({ session_id: sid, ...args }, caller);
      return r.ok ? scriptObservation(r, { run: a.run }) : r;
    },
    reset: async (sid, a, caller) => {
      const r = await sessions.reset({ session_id: sid, reasoning: a.reasoning }, caller);
      return r.ok ? scriptObservation(r, { run: a.run }) : r;
    },
    note: (sid, a, caller) => sessions.note({ session_id: sid, note: a.note }, caller),
    observe: async (sid, a, caller) => {
      const r = sessions.observe({ session_id: sid }, caller);
      return r.ok ? scriptObservation(r) : r;
    },
  };

  return [
    ['POST', ROUTE, async (req, res, { params }) => {
      scriptGuard(req);
      if (!SESSION_ID_RE.test(params.id)) throw new HttpError(404, 'SESSION_UNKNOWN', 'no such session');
      const v = validate(SCHEMAS[params.op], await readJsonBody(req));
      if (v.error) {
        sendJson(res, 200, refuse('INVALID_ARGUMENT', v.error));
        return;
      }
      const caller = { script: { token: bearer(req), run: v.args.run } };
      const out = await ops[params.op](params.id, v.args, caller);
      sendJson(res, out.ok === false && out.code === 'TOKEN_INVALID' ? 401 : 200, out);
    }],
  ];
}
