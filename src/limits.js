// The single source for every bound the backend enforces. The manifest's tool
// schemas repeat some of these (cc validates against them before forwarding);
// tests/manifest.test.mjs pins the two together.

// Longest `reasoning` accepted from an agent, in UTF-16 code units (JS string
// length; the manifest's maxLength counts the same way). The toolkit's own
// byte bound is checked separately in the sidecar, which measures exactly as
// the toolkit does.
export const REASONING_MAX_CHARS = 4000;
export const COORD_MAX = 63;
export const GAME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SESSION_ID_RE = /^s-[0-9a-f]{12}$/;
export const MAX_LIVE_SESSIONS = 8;
export const BODY_MAX_BYTES = 65536;
export const STEPS_PAGE_MAX = 200;
// Sessions per page of GET api/sessions and in the SSE initial state.
export const SESSIONS_PAGE_MAX = 100;
export const SIDECAR_LINE_MAX = 1048576;
// Detail text carried in a refusal (stderr tails, bootstrap output).
export const DETAIL_MAX = 1000;
// Sessions per page of list_sessions' text view, newest first (the json view
// lists every session in scope; `offset` pages the text).
export const LIST_SESSIONS_TEXT_PAGE = 50;
// Live viewer connections at once; past this an SSE request gets 503.
export const SSE_MAX_CLIENTS = 32;
// Bytes an SSE client may leave unsent while it is still behind from an
// earlier write; past this it is dropped. A single large write never trips it.
export const SSE_MAX_BUFFERED_BYTES = 256 * 1024;
// Text view only: a diff touching more rows than this is sent as a full frame
// instead (the json view always lists every changed row).
export const DIFF_MAX_ROWS = 24;

// Scripted play (the note tool, and json-format steps; src/mcp.js).
// Longest run note, in UTF-16 code units; notes per session.
export const NOTE_MAX_CHARS = 2000;
export const NOTES_MAX = 200;
// Per-session step rate: act and reset in either format, plus note. Refused (STEP_RATE_LIMITED), never delayed.
export const STEP_RATE_MAX = 20;
export const STEP_RATE_WINDOW_MS = 1000;
// Steps per session; past it act and reset refuse SESSION_STEP_LIMIT.
export const SESSION_STEPS_MAX = 20000;

// Per-op deadlines for sidecar calls, in ms. `open` covers a first-time game
// download plus a scorecard; all stay under the manifest's mcp.timeoutMs.
export const DEADLINES = Object.freeze({
  configure: 20000,
  list_games: 20000,
  open: 50000,
  step: 25000,
  reset: 25000,
  close: 20000,
  drop: 20000,
});

export const ACTIONS = Object.freeze(['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7']);
// The one action that takes coordinates.
export const COMPLEX_ACTION = 'ACTION6';
