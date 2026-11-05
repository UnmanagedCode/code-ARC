# Protocol

Interface contracts: MCP tools, results, refusal codes, frame text, the HTTP API, SSE events and the sidecar protocol. Bounds are named by their constant in `src/limits.js` (or `src/online.js`); the tool schemas live in `conductor.plugin.json`.

## MCP tools

cc exposes each tool as `code-arc__<name>` and POSTs `{tool, arguments, caller:{sessionId, project}}` to `POST /api/mcp`. Every well-formed call answers HTTP 200. Arguments are validated by cc against the manifest schema and again by the backend against the same schema (`validate` in `src/mcp.js`).

| Tool | Arguments | Returns |
|---|---|---|
| `list_games` | — | `{result:{ok, games:[{game_id, title, tags, downloaded}]}}` |
| `start_session` | `game_id` (required; a listed id or its base before `-`), `online` (default `false`) | observation, first frame full |
| `act` | `session_id`, `action` (`ACTION1`–`ACTION7`), `x`/`y` (ACTION6 only, `0`–`COORD_MAX`), `reasoning` (≤ `REASONING_MAX_CHARS`), `frame` (`diff` default, `full`, `none`) | observation |
| `reset` | `session_id`, `reasoning`, `frame` (`full` default) | observation |
| `observe` | `session_id`, `frame` (`full` default, `none`) | observation from the stored last step; no toolkit call |
| `end_session` | `session_id` | `{result:{ok, session_id, game_id, steps, final:{state, levels_completed, win_levels, scorecard}, scorecard_url?, warnings?}}` |
| `list_sessions` | `scope` (`mine` default, `all`) | `{result:{ok, scope, sessions:[…]}}`, newest first, at most `LIST_SESSIONS_MAX` |

- `reasoning` on `act` reaches the toolkit as `{"text": <reasoning>}`; on `reset` it is recorded for the viewer only (the toolkit's `reset()` takes none).
- `mine` = sessions whose owner `sessionId` equals the caller's (both `null` counts as equal).

### Observation result

`{text: [<frame text>], meta}`; cc renders `meta` as a compact JSON block followed by the raw frame text.

| `meta` field | Meaning |
|---|---|
| `ok` | `true` |
| `session_id`, `game_id`, `title` | `game_id` is the toolkit's resolved, versioned id |
| `mode` | `local` or `online` |
| `status` | `live` or `ended` (`end_reason` present when ended) |
| `state` | `NOT_PLAYED`, `NOT_FINISHED`, `WIN`, `GAME_OVER` |
| `levels_completed`, `win_levels` | progress |
| `available_actions` | e.g. `["ACTION1","ACTION6"]` |
| `step` | `0` = start; increments per `act`/`reset` |
| `frame_count` | frames the action produced (the text shows the last) |
| `full_reset` | the last reset restarted the whole game |
| `frame` | `{mode:"full"}`, `{mode:"full", auto_full:true}`, `{mode:"diff", changed_cells, bbox:{x0,y0,x1,y1}\|null}` or `{mode:"none"}` |
| `online` | online sessions: `{scorecard_url, idle_close_at}` (ISO time) |

### Frame text

- Two header lines carry each column's tens and units digit, offset by the 3-character row label.
- Each row: `yy|` + one hex digit per cell = the palette index (`0`–`f`). `x` = column, `y` = row, origin top-left.
- `diff`: the header plus only changed rows (full row content). No change → `no cells changed`. More than `DIFF_MAX_ROWS` changed rows, or no comparable previous frame → sent full with `auto_full:true`.
- No frame → `no frame`; `frame:"none"` → empty text.

### Refusals

`{result:{ok:false, code, reason, …extra}}`. `{error}` is reserved for an unknown tool, a malformed envelope, or an internal exception.

Gating order for `act`: `SESSION_UNKNOWN` → `SESSION_ENDED` → `NOT_OWNER` → `SESSION_BUSY` → `SESSION_STALLED` → toolkit state → `INVALID_ARGUMENT` → `GAME_FINISHED` → `ACTION_UNAVAILABLE` → `RATE_LIMITED`.

| Code | When | Extra fields |
|---|---|---|
| `INVALID_ARGUMENT` | schema violation; ACTION6 without `x`/`y`, or `x`/`y` on another action; `reasoning` over the toolkit's byte bound as the toolkit measures it (ASCII-escaped JSON; double-encoded online) | `detail` (sidecar checks) |
| `SESSION_UNKNOWN` | no such session | |
| `SESSION_ENDED` | session ended | `end_reason` |
| `SESSION_BUSY` | another call on the session is in flight | |
| `SESSION_STALLED` | an earlier call timed out and hasn't answered | |
| `NOT_OWNER` | owner and caller `sessionId` both known and different (collision guard, not auth) | |
| `TOO_MANY_SESSIONS` | `MAX_LIVE_SESSIONS` live | `live` (ids) |
| `GAME_UNKNOWN` | not in `list_games`, or the toolkit can't find it | |
| `ACTION_UNAVAILABLE` | action not in `available_actions` | `available_actions` |
| `GAME_FINISHED` | non-RESET action in `WIN`/`GAME_OVER` | `state` |
| `TOOLKIT_NOT_READY` | venv still being checked/installed | `state`, `phase` |
| `TOOLKIT_UNAVAILABLE` | venv install failed | `detail` (≤ `DETAIL_MAX`), `fix` |
| `DEPS_DIVERGED` | worktree's symlinked `.venv` doesn't match its `requirements.txt` | `detail`, `fix` |
| `TOOLKIT_TIMEOUT` | no answer within the op's `DEADLINES` entry; the session becomes stalled | `detail` |
| `TOOLKIT_ERROR` | any other toolkit failure | `detail` |
| `SIDECAR_EXITED` | the sidecar died; live sessions end with `sidecar_exit` | `detail` (redacted stderr tail) |
| `NETWORK_ERROR` | timeout / connection failure reaching arcprize.org | `detail` |
| `RATE_LIMITED` | local guard for `ONLINE_RPM_LIMIT` (not sent), or a 429 from arcprize.org | `retry_after_ms` (local guard) |
| `SCORECARD_CLOSED` | arcprize.org no longer knows the game/scorecard; the session ends with `scorecard_auto_closed` | `detail` |

`end_reason` values: `ended_by_agent`, `scorecard_auto_closed`, `sidecar_exit`, `backend_restart`.

## HTTP API

Paths are relative to the plugin root (`/plugins/code-arc/` inside cc). Every response carries the headers in `SECURITY_HEADERS` (`src/http.js`). Non-GET routes require `content-type: application/json` (else 415) and a same-origin `Sec-Fetch-Site` (else 403; without that header, any `Origin` is refused).

| Route | Behaviour |
|---|---|
| `GET api/health` | `{ok:true}`; independent of the toolkit (`healthPath`) |
| `GET api/status` | `{toolkit:{state, phase, detail, python, code}, sidecar:{running, versions}}`; toolkit `state` ∈ `checking`, `installing`, `ready`, `failed`, `diverged` |
| `GET api/sessions` | `{sessions:[meta…]}`, newest first |
| `GET api/sessions/:id` | meta; 404 `SESSION_UNKNOWN` |
| `GET api/sessions/:id/steps?from&limit` | `{steps:[…]}` with `n ≥ from`, at most `STEPS_PAGE_MAX` |
| `GET api/events` | SSE (below) |
| `GET api/settings` | `{apiKey:{set, masked}}` — never the key |
| `PUT api/settings/api-key` | body `{key}` → `{apiKey}`; 400 `INVALID_KEY` (value not echoed); 409 `SESSIONS_ACTIVE` |
| `DELETE api/settings/api-key` | clears → `{apiKey}`; 409 `SESSIONS_ACTIVE` |
| `POST api/mcp` | the MCP endpoint |

Static files: an allowlist of `frontend/` files (`src/static.js`); everything else, including `/pluginBridge.js` and `/pluginTheme.css`, is a real 404.

### Session meta

`{id, game_id, title, mode, owner:{sessionId, project}, scorecard_id, scorecard_url, status, end_reason, stalled, created_at, updated_at, last_activity_at, step_count, last:{state, levels_completed, win_levels, available_actions, frame_count, full_reset}, final?}`

### Step

`{n, ts, action:"START"|"RESET"|"ACTIONn", x?, y?, reasoning?, state, levels_completed, win_levels, available_actions, frame_count, full_reset, frame:[hex rows]}`

### SSE events (`api/events`)

| Event | Data |
|---|---|
| `status` | the `api/status` body; first on every connection, again on changes |
| `sessions` | the full session list; second on every connection |
| `session` | one session meta (create/update) |
| `step` | `{session_id, step}` |

Event ids are `<boot>-<n>`; a reconnect with `Last-Event-ID` (or `?lastEventId=`) replays missed events from a small ring. `: ping` keepalives.

## Sidecar protocol

JSON lines between `src/sidecar.js` and `sidecar/arc_sidecar.py`: requests on the child's stdin, replies on its original stdout (fd 1 is redirected to stderr inside the child). Lines are capped at `SIDECAR_LINE_MAX`; a longer line kills the child.

- Startup: `{"event":"ready","versions":{"arc_agi":…,"arcengine":…}}` (the backend logs a warning if they differ from `requirements.txt`).
- Request `{"id":n,"op":…,"args":{…}}` → `{"id":n,"ok":true,"result":{…}}` or `{"id":n,"ok":false,"code":…,"detail":…}`.

| op | args | result |
|---|---|---|
| `configure` | `{api_key}` | `{}`; must come first (else `NOT_CONFIGURED`) |
| `list_games` | — | `{games}` |
| `open` | `{session_id, game_id, online}` | `{scorecard_id, game_id, title, obs}` |
| `step` | `{session_id, action, x?, y?, reasoning?}` | `{obs}` |
| `reset` | `{session_id}` | `{obs}` |
| `close` | `{session_id}` | `{scorecard: summary\|null}` |
| `drop` | `{session_id}` | `{}` (forget without closing) |

`obs` = `{state, levels_completed, win_levels, available_actions:[int], full_reset, frame_count, frame:[hex rows]|null}` (last frame only, validated to the palette and to `FRAME_MAX` in `sidecar/engine.py`).
