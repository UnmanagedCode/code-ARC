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
export const SIDECAR_LINE_MAX = 1048576;
// Detail text carried in a refusal (stderr tails, bootstrap output).
export const DETAIL_MAX = 1000;
// list_sessions returns at most this many, newest first.
export const LIST_SESSIONS_MAX = 50;
// Live viewer connections at once; past this an SSE request gets 503.
export const SSE_MAX_CLIENTS = 32;
// Bytes a slow SSE client may leave unsent before it is dropped.
export const SSE_MAX_BUFFERED_BYTES = 256 * 1024;
// A diff touching more rows than this is sent as a full frame instead.
export const DIFF_MAX_ROWS = 24;

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
