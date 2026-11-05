# Protocol

Interface contracts: MCP tools, results, refusal codes, frame text, the HTTP API, the script HTTP API, SSE events and the sidecar protocol. Bounds are named by their constant in `src/limits.js` (or `src/online.js`); the tool schemas live in `conductor.plugin.json`.

## MCP tools

cc exposes each tool as `code-arc__<name>` and POSTs `{tool, arguments, caller:{sessionId, project}}` to `POST /api/mcp`. Every well-formed call answers HTTP 200. Arguments are validated by cc against the manifest schema and again by the backend against the same schema (`validate` in `src/schema.js`).

| Tool | Arguments | Returns |
|---|---|---|
| `list_games` | — | `{result:{ok, games:[{game_id, title, tags, downloaded}]}}`; a failed game-list fetch is a refusal (`NETWORK_ERROR`, `RATE_LIMITED`, `TOOLKIT_ERROR`), never an empty list |
| `start_session` | `game_id` (required; a listed id or its base before `-`), `online` (default `false`) | observation, first frame full, plus `meta.script` |
| `act` | `session_id`, `action` (`ACTION1`–`ACTION7`), `x`/`y` (ACTION6 only, `0`–`COORD_MAX`), `reasoning` (≤ `REASONING_MAX_CHARS`), `frame` (`diff` default, `full`, `none`) | observation |
| `reset` | `session_id`, `reasoning`, `frame` (`full` default) | observation |
| `observe` | `session_id`, `frame` (`full` default, `none`) | observation from the stored last step; no toolkit call |
| `end_session` | `session_id` | `{result:{ok, session_id, game_id, steps, final:{state, levels_completed, win_levels, scorecard}, scorecard_url?, warnings?}}` |
| `list_sessions` | `scope` (`mine` default, `all`) | `{result:{ok, scope, sessions:[…]}}`, newest first, at most `LIST_SESSIONS_MAX` |
| `script_access` | `session_id` | `{result:{ok, session_id, script}}`: a fresh script token; the previous token stops working at once and the current run closes (next script call → `NOTE_REQUIRED`). Gating: `SESSION_UNKNOWN` → `SESSION_ENDED` → `NOT_OWNER` |

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
| `frame` | `{mode:"full"}`, `{mode:"full", auto_full:true}`, `{mode:"diff", changed_cells, bbox:{x0,y0,x1,y1}\|null}` or `{mode:"none"}`. `changed_cells` = cells that differ between the previous step's last frame and this one's (animation frames in between are not counted); `bbox` = the smallest box (inclusive) covering every changed cell, status-bar cells included |
| `online` | online sessions: `{scorecard_url, idle_close_at}` (ISO time) |
| `script` | `start_session` only: `{base_url, token, client}` (see [Script HTTP API](#script-http-api)); no other observation carries it |

### Frame text

- Two header lines: `xx|` + each column's tens digit, then `xx|` + its units digit. No line starts with whitespace; column `x` is at index `3 + x` on every line.
- Each row: `yy|` + one hex digit per cell = the palette index (`0`–`f`). `x` = column, `y` = row, origin top-left.
- `diff`: the header plus only changed rows (full row content). No change → `no cells changed`. More than `DIFF_MAX_ROWS` changed rows, or no comparable previous frame → sent full with `auto_full:true`.
- No frame → `no frame`; `frame:"none"` → empty text.

### Refusals

`{result:{ok:false, code, reason, …extra}}`. `{error}` is reserved for an unknown tool, a malformed envelope, or an internal exception.

Gating order for `act`: `SESSION_UNKNOWN` → `SESSION_ENDED` → `NOT_OWNER` → `SESSION_BUSY` → `SESSION_STALLED` → toolkit state → `INVALID_ARGUMENT` → `GAME_FINISHED` → `ACTION_UNAVAILABLE` → `SESSION_STEP_LIMIT` → `STEP_RATE_LIMITED` → `RATE_LIMITED`. `reset`: the same without the action checks.

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
| `TOOLKIT_NOT_READY` | venv still being checked/installed (or stopped); or, for `start_session`, an API key change in progress (`state:"reconfiguring"`) | `state`, `phase` |
| `TOOLKIT_UNAVAILABLE` | venv install failed | `detail` (≤ `DETAIL_MAX`), `fix` |
| `DEPS_DIVERGED` | worktree's symlinked `.venv` doesn't match its `requirements.txt` | `detail`, `fix` |
| `TOOLKIT_TIMEOUT` | no answer within the op's `DEADLINES` entry; the session becomes stalled | `detail` |
| `TOOLKIT_ERROR` | any other toolkit failure; arcprize.org refusing the API key (401/403) is this code with a detail that says so | `detail` |
| `SIDECAR_EXITED` | the sidecar died; live sessions end with `sidecar_exit` | `detail` (redacted stderr tail) |
| `NETWORK_ERROR` | timeout / connection failure reaching arcprize.org | `detail` |
| `RATE_LIMITED` | local guard for `ONLINE_RPM_LIMIT` (not sent), or a 429 from arcprize.org | `retry_after_ms` (local guard) |
| `STEP_RATE_LIMITED` | the session took `STEP_RATE_MAX` steps in the last `STEP_RATE_WINDOW_MS` (`act`/`reset` from tools and scripts, script `attach`/`note`); refused, never delayed, not sent | `retry_after_ms` |
| `SESSION_STEP_LIMIT` | `act`/`reset` on a session whose step count reached `SESSION_STEPS_MAX`; `end_session` and start a new one | |
| `TOKEN_INVALID` | script routes: the bearer token is missing, malformed, wrong, replaced by `script_access`, or from before a backend restart (HTTP 401) | |
| `NOTE_REQUIRED` | script `act`/`reset`/`note` with no run open (no attach yet, or `script_access` closed it) | |
| `RUN_SUPERSEDED` | script `act`/`reset`/`note` naming a run that a newer `attach`/`note` replaced | |
| `TOO_MANY_NOTES` | script `attach`/`note` past `NOTES_MAX` notes on the session | |
| `SCORECARD_CLOSED` | arcprize.org no longer knows the game/scorecard; the session ends with `scorecard_auto_closed` | `detail` |

`end_reason` values: `ended_by_agent`, `scorecard_auto_closed`, `sidecar_exit`, `backend_restart`.

## HTTP API

Paths are relative to the plugin root (`/plugins/code-arc/` inside cc). Every response carries the headers in `SECURITY_HEADERS` (`src/http.js`). Non-GET routes require `content-type: application/json` (else 415) and a same-origin `Sec-Fetch-Site` (else 403; without that header, any `Origin` is refused). The script routes go further: see [Script HTTP API](#script-http-api).

| Route | Behaviour |
|---|---|
| `GET api/health` | `{ok:true}`; independent of the toolkit (`healthPath`) |
| `GET api/status` | `{toolkit:{state, phase, detail, fix, python, code}, sidecar:{running, versions}}`; toolkit `state` ∈ `checking`, `installing`, `ready`, `failed`, `diverged`, `stopped`; `fix` is set for `failed` and `diverged` |
| `GET api/sessions?before&limit` | `{sessions:[meta…], total, next}`: newest first, at most `SESSIONS_PAGE_MAX`, starting after the session id `before` (400 if malformed); `next` is the `before` for the following page, `null` at the end; `total` counts every stored session |
| `GET api/sessions/:id` | meta; 404 `SESSION_UNKNOWN` |
| `GET api/sessions/:id/steps?from&limit` | `{steps:[…]}` with `n ≥ from`, at most `STEPS_PAGE_MAX` |
| `GET api/sessions/:id/notes` | `{notes:[…]}`, every script run note of the session in run order (at most `NOTES_MAX`); 404 `SESSION_UNKNOWN` |
| `GET api/events` | SSE (below) |
| `GET api/settings` | `{apiKey:{set, masked}}` — never the key |
| `PUT api/settings/api-key` | body `{key}` → `{apiKey}`; 400 `INVALID_KEY` (value not echoed); 409 `SESSIONS_ACTIVE` while any session is live or starting; 409 `KEY_CHANGE_IN_PROGRESS` while another key change is being saved. Error bodies are `{error, code}`; `error` is the reason to show the user |
| `DELETE api/settings/api-key` | clears → `{apiKey}`; the same 409s |
| `POST api/mcp` | the MCP endpoint |
| `POST api/play/:id/<op>` | the script HTTP API (below) |

Static files: an allowlist of `frontend/` files (`src/static.js`); everything else, including `/pluginBridge.js` and `/pluginTheme.css`, is a real 404.

### Session meta

`{id, game_id, title, mode, owner:{sessionId, project}, scorecard_id, scorecard_url, status, end_reason, stalled, created_at, updated_at, last_activity_at, step_count, last:{state, levels_completed, win_levels, available_actions, frame_count, full_reset}, final?}`

### Step

`{n, ts, action:"START"|"RESET"|"ACTIONn", source:"tool"|"script", run?, x?, y?, reasoning?, state, levels_completed, win_levels, available_actions, frame_count, full_reset, frame:[hex rows]}`

- `source` is missing on steps recorded before scripting existed: read it as `tool`. `run` is set on script steps only.
- On disk a step line carries `frame_z` (base64 raw deflate of the rows joined by `\n`) instead of `frame`; every API and SSE step has `frame` rows. Lines with a plain `frame` still read.

### Note

`{run, ts, text, from_step}`: the note that opened script run `run`; `from_step` = the session's step count + 1 when it was written (the first step the run can take). Stored in `sessions/<sid>/notes.jsonl`; `text` is stored as sent (untrimmed).

### SSE events (`api/events`)

| Event | Data |
|---|---|
| `status` | the `api/status` body; first on every connection, again on changes |
| `sessions` | the newest page, same shape as `GET api/sessions` (`{sessions, total, next}`); second on every connection. Older sessions: `GET api/sessions?before=<next>` |
| `session` | one session meta (create/update) |
| `step` | `{session_id, step}` |
| `note` | `{session_id, note}` (a script attached or changed its plan) |

At most `SSE_MAX_CLIENTS` connections: a new one evicts the most backed-up connection, else the oldest. The preference protects a viewer only from stalled or backed-up clients; a client that keeps opening fresh connections (no backlog) still evicts by age and is limited only by `SSE_MAX_CLIENTS` turnover. A client that is still behind from an earlier write (no drain yet) with more than `SSE_MAX_BUFFERED_BYTES` unsent is disconnected; one large write (the initial state) never trips this on its own. Event ids are `<boot>-<n>`; a reconnect with `Last-Event-ID` (or `?lastEventId=`) replays missed events from a small ring. `: ping` keepalives.

## Script HTTP API

For an agent's Python script (`clients/code_arc.py`). Same session service as the MCP tools: the same gating, refusal codes, step log and SSE events. Script steps are recorded with `source:"script"` and the run they belong to.

**Where:** `meta.script` from `start_session` (or `script_access`'s result) = `{base_url, token, client}`.

- `base_url` = the backend's own address, `http://127.0.0.1:<port>/api/play/<session_id>/` (not cc's proxy). The port changes only when the plugin restarts, which ends every session anyway.
- `client` = the absolute path of `clients/code_arc.py` in the plugin checkout.
- `token` = 32 random bytes, base64url. Kept in backend memory only (as its sha256), valid while the process runs: an ended session refuses it with `SESSION_ENDED` (+ `end_reason`); after a restart it is unknown (`TOKEN_INVALID`). It appears only in `start_session`'s `meta.script` and `script_access`'s result: never in the store, steps, notes, SSE, `api/*` or logs.

**Every request:** `POST <base_url><op>` with

- `content-type: application/json` (else 415);
- no `Origin` and no `Sec-Fetch-Site` header (else 403 `CROSS_SITE`, "script routes are for non-browser clients"; even the same-origin viewer can't call them);
- `Authorization: Bearer <token>` (the header only, never the query or body; at most `SCRIPT_AUTH_HEADER_MAX` characters);
- a body of at most `BODY_MAX_BYTES`, validated against the op's flat schema (unknown keys, wrong types or bounds → `INVALID_ARGUMENT`, before any other check).

A session id that isn't `s-` + 12 hex digits is 404 `SESSION_UNKNOWN`; a well-formed unknown id is the 200 refusal `SESSION_UNKNOWN`.

| op | body | ok result |
|---|---|---|
| `attach` | `{note}` (1–`NOTE_MAX_CHARS`, not blank after trimming) | observation + `run` (a new run, which supersedes any other) |
| `act` | `{run, action, x?, y?, reasoning?}` (same bounds as the `act` tool) | observation + `run` |
| `reset` | `{run, reasoning?}` | observation + `run` |
| `note` | `{run, note}` | `{ok:true, run}` (the new run) |
| `observe` | `{}` | observation (from the stored last step; no toolkit call) |

- **Runs:** a run is the segment opened by one note. `attach` opens run `k`; `note` opens `k+1`. `act`/`reset`/`note` must name the current run: none open → `NOTE_REQUIRED`, an older one → `RUN_SUPERSEDED`. Runs never expire; tool steps in between don't end one. `script_access` closes the current run (run numbers keep counting).
- **Observation** (200): `{ok:true, session_id, game_id, mode, status, end_reason?, state, levels_completed, win_levels, available_actions:["ACTIONn"…], step, frame_count, full_reset, frame:[hex rows]|null, online?, run?}`: the MCP `meta` fields minus `title` and the frame-text `frame` mode, with the raw rows.
- **Refusal** (200): `{ok:false, code, reason, …extra}` with the MCP codes. `TOKEN_INVALID` is HTTP 401 with the same body.
- **Router errors** keep the `{error, code}` shape: 400 `BAD_JSON`, 413 `BODY_TOO_LARGE`, 415, 403 `CROSS_SITE`, 404, 405.

**Gating order:**

- `act`: `SESSION_UNKNOWN` → `TOKEN_INVALID` → `SESSION_ENDED` → `NOTE_REQUIRED` / `RUN_SUPERSEDED` → `SESSION_BUSY` → `SESSION_STALLED` → toolkit state → `INVALID_ARGUMENT` → `GAME_FINISHED` → `ACTION_UNAVAILABLE` → `SESSION_STEP_LIMIT` → `STEP_RATE_LIMITED` → `RATE_LIMITED`. `reset`: the same without the action checks.
- `attach`: `SESSION_UNKNOWN` → `TOKEN_INVALID` → `SESSION_ENDED` → `INVALID_ARGUMENT` (blank note) → `TOO_MANY_NOTES` → `STEP_RATE_LIMITED`. No busy or stalled check (no toolkit call).
- `note`: as `attach`, with `NOTE_REQUIRED` / `RUN_SUPERSEDED` after `SESSION_ENDED`.
- `observe`: `SESSION_UNKNOWN` → `TOKEN_INVALID` → `SESSION_ENDED`.

The token replaces ownership: a script call is never `NOT_OWNER`. Tool callers are still owner-checked.

### Python client (`clients/code_arc.py`)

Stdlib only, Python ≥ 3.8; import it from the directory of `meta.script.client`. Usage example in its module docstring.

| Name | Behaviour |
|---|---|
| `Session.attach(base_url, token, note, timeout=60)` | POSTs `attach`; keeps `.run`, `.session_id`, `.last` |
| `.act(action, x=None, y=None, reasoning=None)`, `.reset(reasoning=None)`, `.observe()` | send the current run where needed; return an `Observation` |
| `.note(text)` | opens the next run; updates and returns `.run` |
| `Observation` | `.session_id`, `.step`, `.status`, `.end_reason`, `.state`, `.levels_completed`, `.win_levels`, `.available_actions` (list of str), `.frame_count`, `.full_reset`, `.grid` (64×64 `list[list[int]]` or `None`), `.online`, `.raw` |
| `Refusal` | any `ok:false` body, or a 4xx `{error, code}`: `.code`, `.reason`, `.extra` (dict), `.retry_after_ms` (or `None`) |
| `TransportError` | unreachable, non-JSON body, or 5xx; the message names `base_url` |

No retries of any kind. HTTP proxies from the environment are bypassed (the backend is local).

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
