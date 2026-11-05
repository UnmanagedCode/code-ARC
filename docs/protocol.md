# Protocol

Interface contracts: MCP tools, results, refusal codes, frame text, the HTTP API, SSE events and the sidecar protocol. The script HTTP API and its Python client: [script-api.md](script-api.md). Bounds are named by their constant in `src/limits.js` (or `src/online.js`); the tool schemas live in `conductor.plugin.json`.

## MCP tools

cc exposes each tool as `code-arc__<name>` and POSTs `{tool, arguments, caller:{sessionId, project}}` to `POST /api/mcp`. Every well-formed call answers HTTP 200. Arguments are validated by cc against the manifest schema and again by the backend against the same schema (`validate` in `src/schema.js`).

| Tool | Arguments | Returns |
|---|---|---|
| `list_games` | — | `{result:{ok, games:[{game_id, title, tags, downloaded, source}]}}`; `source` is `bundle` (from the offline bundle, [bundle.md](bundle.md)) or `web`; a failed game-list fetch is a refusal (`NETWORK_ERROR`, `RATE_LIMITED`, `TOOLKIT_ERROR`), never an empty list; with a bundle, a failed or slow web list degrades to the bundle's games instead of a refusal |
| `start_session` | `game_id` (required; a listed id or its base before `-`), `online` (default `false`) | observation, first frame full, plus `meta.script` |
| `act` | `session_id`, `action` (`ACTION1`–`ACTION7`), `x`/`y` (ACTION6 only, `0`–`COORD_MAX`), `reasoning` (≤ `REASONING_MAX_CHARS`), `frame` (`diff` default, `full`, `none`, `image`), `image_scale`/`image_grid` (`frame:"image"` only; [Board image](#board-image)) | observation |
| `reset` | `session_id`, `reasoning`, `frame` (`full` default, `diff`, `none`, `image`), `image_scale`/`image_grid` | observation |
| `observe` | `session_id`, `frame` (`full` default, `none`, `image`), `image_scale`/`image_grid` | observation from the stored last step; no toolkit call |
| `end_session` | `session_id` | `{result:{ok, session_id, game_id, steps, final:{state, levels_completed, win_levels, scorecard}, scorecard_url?, warnings?}}` |
| `list_sessions` | `scope` (`mine` default, `all`) | `{result:{ok, scope, sessions:[…]}}`, newest first, at most `LIST_SESSIONS_MAX` |
| `script_access` | `session_id` | `{result:{ok, session_id, script}}`: a fresh script token; the previous token stops working at once and the current run closes (next script call → `NOTE_REQUIRED`). Gating: `SESSION_UNKNOWN` → `SESSION_ENDED` → `NOT_OWNER`, where `NOT_OWNER` is strict here: refused unless the caller's `sessionId` is a non-empty string equal to the owner's, so a null or empty caller is refused, and a session whose owner is null or empty can't be rotated by anyone |

- `reasoning` on `act` reaches the toolkit as `{"text": <reasoning>}`; on `reset` it is recorded for the viewer only (the toolkit's `reset()` takes none).
- `mine` = sessions whose owner `sessionId` equals the caller's (both `null` counts as equal).
- Ownership elsewhere is a collision guard: `NOT_OWNER` only when owner and caller `sessionId` are both known and differ. `script_access` is the exception (above).

### Observation result

`{text: [<frame text>], meta}`; cc renders `meta` as a compact JSON block followed by the raw frame text. With `frame:"image"` the text is empty and the image is a file (`meta.frame.path`): a result never carries image bytes.

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
| `frame` | `{mode:"full"}`, `{mode:"full", auto_full:true}`, `{mode:"diff", changed_cells, bbox:{x0,y0,x1,y1}\|null}`, `{mode:"none"}`, or for `frame:"image"`: `{mode:"image", path}` (absolute path of the PNG), `{mode:"image"}` with text `no frame` (no frame stored) or `no image: the session ended` (it ended during the call), or `{mode:"image", error}` (the file could not be written; the action still happened). `changed_cells` = cells that differ between the previous step's last frame and this one's (animation frames in between are not counted); `bbox` = the smallest box (inclusive) covering every changed cell, status-bar cells included |
| `online` | online sessions: `{scorecard_url, idle_close_at}` (ISO time) |
| `script` | `start_session` only: `{base_url, token, client}` (see [script-api.md](script-api.md)); no other observation carries it |

### Frame text

- Two header lines: `xx|` + each column's tens digit, then `xx|` + its units digit. No line starts with whitespace; column `x` is at index `3 + x` on every line.
- Each row: `yy|` + one hex digit per cell = the palette index (`0`–`f`). `x` = column, `y` = row, origin top-left.
- `diff`: the header plus only changed rows (full row content). No change → `no cells changed`. More than `DIFF_MAX_ROWS` changed rows, or no comparable previous frame → sent full with `auto_full:true`.
- No frame → `no frame`; `frame:"none"` → empty text.

### Board image

`frame:"image"` on `act`, `reset` or `observe` renders the observation's frame to a PNG file and returns its absolute path in `meta.frame.path`; the agent opens it with its Read tool. Names written as `palette`, `scale.*` and `grid.*` below are keys of `clients/board_image.json`, the single source for the image's numbers and colours, read by both `src/boardImage.js` and `Observation.save_png` in `clients/code_arc.py`. `FRAME_SIDE` is the largest frame side, `COORD_MAX + 1` from `src/limits.js` (the Python client checks the same bound).

| Option | Values | Default |
|---|---|---|
| `image_scale` | integer, `scale.min`–`scale.max` pixels per cell | `scale.default` |
| `image_grid` | boolean: lines, ticks and labels | `grid.default` |

- Either option without `frame:"image"` → `INVALID_ARGUMENT` before any toolkit call. Out-of-bounds values → `INVALID_ARGUMENT` (schema). The manifest schemas carry no `default` for them (a schema default would be filled in by `validate()` and hide a stray option); `tests/manifest.test.mjs` pins the bounds and the described defaults to the spec.
- Live sessions only: `observe` with `frame:"image"` on an ended session → `SESSION_ENDED` (`frame:"full"` still works).
- Largest image: `grid.margin + FRAME_SIDE·scale.max` pixels a side.

**File lifecycle:** `<data dir>/images/<sid>/step-<n>-<seq>.png` (0600, dirs 0700), `n` = the observation's `step`, `seq` = a per-session counter, so every image has a path of its own (a reader never gets a cached older copy). Only the newest file per session is kept: each write unlinks the one file the backend wrote before it, nothing else. `images/` and each session dir must be real directories (a symlink or other file in their place makes the write fail with `meta.frame.error`, writing nothing and changing no mode), and a session dir's realpath must sit directly under `images/`'s. The session's dir is removed when the session ends (every end path) and all of `images/` when the backend starts.

**Pixel rules** (PNG: 8-bit RGB, colour type 2, no alpha, not interlaced, filter 0 on every row). `rows` = H×W hex rows, 1 ≤ H, W ≤ `FRAME_SIDE`, rectangular; `s` = scale; `g` = grid on; `M = g ? grid.margin : 0`.

- Size: `(M + W·s) × (M + H·s)`. Pixels outside the image are never drawn (labels near an edge are clipped).
- Margin (`x < M` or `y < M`): `grid.margin_rgb`.
- Board pixel `(px, py)`: cell `(⌊(px−M)/s⌋, ⌊(py−M)/s⌋)`, coloured `palette[digit]`.
- Lines (`g` only): for each `c = grid.every·k`, `k ≥ 1`, `c < W`, the board pixel column `px = M + c·s` is a vertical line; for `c < H`, the board pixel row `py = M + c·s` a horizontal one. A line pixel is drawn only where `⌊along/grid.dash⌋` is even, `along` = its offset from the board origin along the line (`py − M` vertical, `px − M` horizontal), in `grid.contrast[digit of the cell under it]` (so crossings don't depend on drawing order).
- Ticks (`g` only): for each `c = grid.every·k`, `k ≥ 0`: columns `c < W` → pixels `px = M + c·s`, `py ∈ [M − grid.tick_len, M)`; rows `c < H` → the same in the left margin (`px ∈ [M − grid.tick_len, M)`, `py = M + c·s`); colour `grid.label_rgb`.
- Labels (`g` only): the decimal digits of each ticked `c`. Origin: top margin `(M + c·s + grid.label_offset, grid.label_offset)`; left margin `(grid.label_offset, M + c·s + grid.label_offset)`. Digit `i` starts at `origin.x + i·(glyph width + 1)·grid.font_scale`; each `#` at glyph cell `(gx, gy)` of `grid.glyphs[digit]` fills the `grid.font_scale`-square block at `(digit.x + gx·grid.font_scale, origin.y + gy·grid.font_scale)` with `grid.label_rgb`.
- Rendering fails loudly (throws / raises) on ragged rows, a non-hex digit, a shape outside 1–`FRAME_SIDE` or an option out of bounds.
- `palette` is `arc_agi.rendering.COLOR_MAP` without alpha (pinned to `frontend/palette.js` by `tests/boardImage.test.mjs`, to the toolkit by the gated real-toolkit test). `grid.contrast` is stored in the spec; it was derived from `palette` by the rule "black where palette colour `i` has `0.299R + 0.587G + 0.114B ≥ 128`, else white", which `tests/boardImage.test.mjs` re-checks.

### Refusals

`{result:{ok:false, code, reason, …extra}}`. `{error}` is reserved for an unknown tool, a malformed envelope, or an internal exception.

Gating order for `act`: `SESSION_UNKNOWN` → `SESSION_ENDED` → `NOT_OWNER` → `SESSION_BUSY` → `SESSION_STALLED` → toolkit state → `INVALID_ARGUMENT` → `GAME_FINISHED` → `ACTION_UNAVAILABLE` → `SESSION_STEP_LIMIT` → `STEP_RATE_LIMITED` → `RATE_LIMITED`. `reset`: the same without the action checks. Schema refusals, and image options without `frame:"image"`, come before all of these.

| Code | When | Extra fields |
|---|---|---|
| `INVALID_ARGUMENT` | schema violation; ACTION6 without `x`/`y`, or `x`/`y` on another action; `image_scale`/`image_grid` without `frame:"image"`; `reasoning` over the toolkit's byte bound as the toolkit measures it (ASCII-escaped JSON; double-encoded online) | `detail` (sidecar checks) |
| `SESSION_UNKNOWN` | no such session | |
| `SESSION_ENDED` | session ended; also `observe` with `frame:"image"` on an ended session | `end_reason` |
| `SESSION_BUSY` | another call on the session is in flight | |
| `SESSION_STALLED` | an earlier call timed out and hasn't answered | |
| `NOT_OWNER` | owner and caller `sessionId` both known and different (collision guard, not auth) | |
| `TOO_MANY_SESSIONS` | `MAX_LIVE_SESSIONS` live | `live` (ids) |
| `GAME_UNKNOWN` | not in `list_games`, or the toolkit can't find it (with a bundle and no network, games outside the bundle are not listed: a local start of one gets a `detail` saying the web game list could not be fetched) | `detail` (bundle case only) |
| `ACTION_UNAVAILABLE` | action not in `available_actions` | `available_actions` |
| `GAME_FINISHED` | non-RESET action in `WIN`/`GAME_OVER` | `state` |
| `TOOLKIT_NOT_READY` | venv still being checked/installed (or stopped); or, for `start_session`, an API key change in progress (`state:"reconfiguring"`) | `state`, `phase` |
| `TOOLKIT_UNAVAILABLE` | venv install failed, or the offline bundle was rejected ([bundle.md](bundle.md)) | `detail` (≤ `DETAIL_MAX`), `fix` |
| `DEPS_DIVERGED` | worktree's symlinked `.venv` doesn't match its `requirements.txt` | `detail`, `fix` |
| `TOOLKIT_TIMEOUT` | no answer within the op's `DEADLINES` entry; the session becomes stalled | `detail` |
| `TOOLKIT_ERROR` | any other toolkit failure; arcprize.org refusing the API key (401/403) is this code with a detail that says so | `detail` |
| `SIDECAR_EXITED` | the sidecar died; live sessions end with `sidecar_exit` | `detail` (redacted stderr tail) |
| `NETWORK_ERROR` | timeout / connection failure reaching arcprize.org; also `start_session` `online:true` for a game outside the offline bundle while the web game list can't be fetched | `detail` |
| `RATE_LIMITED` | local guard for `ONLINE_RPM_LIMIT` (not sent), or a 429 from arcprize.org | `retry_after_ms` (local guard) |
| `STEP_RATE_LIMITED` | the session took `STEP_RATE_MAX` steps in the last `STEP_RATE_WINDOW_MS` (`act`/`reset` from tools and scripts, script `attach`/`note`); refused, never delayed, not sent | `retry_after_ms` |
| `SESSION_STEP_LIMIT` | `act`/`reset` on a session whose step count reached `SESSION_STEPS_MAX`; `end_session` and start a new one | |
| `TOKEN_INVALID` | script routes, live session: the bearer token is missing, malformed, wrong or replaced by `script_access` (HTTP 401). An ended session (also after a backend restart) answers `SESSION_ENDED` before any token check | |
| `NOTE_REQUIRED` | script `act`/`reset`/`note` with no run open (no attach yet, or `script_access` closed it) | |
| `RUN_SUPERSEDED` | script `act`/`reset`/`note` naming a run that a newer `attach`/`note` replaced | |
| `TOO_MANY_NOTES` | script `attach`/`note` past `NOTES_MAX` notes on the session | |
| `SCORECARD_CLOSED` | arcprize.org no longer knows the game/scorecard; the session ends with `scorecard_auto_closed` | `detail` |

`end_reason` values: `ended_by_agent`, `scorecard_auto_closed`, `sidecar_exit`, `backend_restart`.

## HTTP API

Paths are relative to the plugin root (`/plugins/code-arc/` inside cc). Every response carries the headers in `SECURITY_HEADERS` (`src/http.js`). Non-GET routes require `content-type: application/json` (else 415) and a same-origin `Sec-Fetch-Site` (else 403; without that header, any `Origin` is refused). The script routes go further: see [script-api.md](script-api.md).

| Route | Behaviour |
|---|---|
| `GET api/health` | `{ok:true}`; independent of the toolkit (`healthPath`) |
| `GET api/status` | `{toolkit:{state, phase, detail, fix, python, code, source, bundle}, sidecar:{running, versions}}`; toolkit `state` ∈ `checking`, `installing`, `ready`, `failed`, `diverged`, `stopped`; `fix` is set for `failed` and `diverged`; `source` ∈ `web`, `bundle`, `null`; `bundle` is `null` or `{location, path, id, created_at, target, toolkit, games, shadowed}` (`id` `null` for a rejected bundle; [bundle.md](bundle.md)) |
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

`{n, ts, action:"START"|"RESET"|"ACTIONn", source:"tool"|"script", run?, x?, y?, reasoning?, state, levels_completed, win_levels, available_actions, frame_count, full_reset, frame:[hex rows]|null}`

- `source` is missing on steps recorded before scripting existed: read it as `tool`. `run` is set on script steps only.
- On disk a step line carries `frame_z` (base64 raw deflate of the rows joined by `\n`) instead of `frame`; every API and SSE step has `frame` rows. Lines with a plain `frame` still read. A corrupt or tampered stored frame reads as `frame: null` ([architecture.md](architecture.md) → On-disk state).

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

`POST api/play/:id/<op>` and the Python client (`clients/code_arc.py`): see [script-api.md](script-api.md).

## Sidecar protocol

JSON lines between `src/sidecar.js` and `sidecar/arc_sidecar.py`: requests on the child's stdin, replies on its original stdout (fd 1 is redirected to stderr inside the child). Lines are capped at `SIDECAR_LINE_MAX`; a longer line kills the child.

- Startup: `{"event":"ready","versions":{"arc_agi":…,"arcengine":…}}` (the backend logs a warning if they differ from `requirements.txt`).
- Request `{"id":n,"op":…,"args":{…}}` → `{"id":n,"ok":true,"result":{…}}` or `{"id":n,"ok":false,"code":…,"detail":…}`.

| op | args | result |
|---|---|---|
| `configure` | `{api_key, games_dir}` | `{}`; must come first (else `NOT_CONFIGURED`); `games_dir` is the verified bundle's games dir or `null` (else `INVALID_ARGUMENT` unless an existing absolute dir) |
| `list_games` | — | `{games, web_unavailable?}`; `web_unavailable: {code, detail}` only with a `games_dir` whose web list failed (`code` = its refusal) or is still loading (`WEB_LIST_LOADING`) |
| `open` | `{session_id, game_id, online}` | `{scorecard_id, game_id, title, obs}` |
| `step` | `{session_id, action, x?, y?, reasoning?}` | `{obs}` |
| `reset` | `{session_id}` | `{obs}` |
| `close` | `{session_id}` | `{scorecard: summary\|null}` |
| `drop` | `{session_id}` | `{}` (forget without closing) |

`obs` = `{state, levels_completed, win_levels, available_actions:[int], full_reset, frame_count, frame:[hex rows]|null}` (last frame only, validated to the palette and to `FRAME_MAX` in `sidecar/engine.py`).
