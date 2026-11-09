# Protocol

Interface contracts: MCP tools, results, refusal codes, frame text, the HTTP API, SSE events and the sidecar protocol. Scripted play: [scripted-play.md](scripted-play.md). Bounds are named by their constant in `src/limits.js` (or `src/online.js`); the tool input and output schemas live in `conductor.plugin.json` (`inputSchema`, `outputSchema`).

## MCP tools

cc exposes each tool as `code-arc__<name>` and POSTs `{tool, arguments, caller:{sessionId, project}, format}` to `POST /api/mcp`. Every well-formed call answers HTTP 200. Arguments are validated by cc against the manifest schema and again by the backend against the same schema (`validate` in `src/schema.js`).

**Formats.** `format` is `json` or `text`; the reply is one of:

| Reply | Shape |
|---|---|
| json success | `{structured}` only: the complete data, validated by cc against the tool's manifest `outputSchema` (the REST alias, and so `run_code` programs, read this) |
| text success | `{text}` only: one prose string (no `meta`), for agents; field names (`state`, `levels_completed`, `available_actions`, `frame_count`, `changed_cells`, `bbox`, …) appear verbatim |
| refusal, either format | `{error, code, details?}`: see [Refusals](#refusals) |

Dispatch (`handle` in `src/mcp.js`) checks, in order: envelope (malformed → `INVALID_ARGUMENT`), `format` (absent → treated as `text`; present but not `json`/`text` → `INVALID_ARGUMENT`, before any work), tool (unknown → `TOOL_UNKNOWN`), arguments (schema violation → `INVALID_ARGUMENT`), then the handler (a thrown exception → `INTERNAL`, logged; the message names only the tool). The json view never carries an `ok` field. Only the requested view is built.

The tables below give each tool's json `structured` fields; the text view of each is a prose rendering of the same data (`src/toolText.js`). The one text-only bound: `list_sessions` text pages.

| Tool | Arguments | `structured` (json view) |
|---|---|---|
| `list_games` | — | `{games:[{game_id, title, tags, downloaded, source}], web_unavailable?}`; `source` is `bundle` (from the offline bundle, [bundle.md](bundle.md)) or `web`; `web_unavailable: {code, detail}` is present when, with a bundle, the web game list failed or is still loading (the text view says only the bundle's games are listed); a failed game-list fetch without a bundle is a refusal (`NETWORK_ERROR`, `RATE_LIMITED`, `TOOLKIT_ERROR`), never an empty list |
| `start_session` | `game_id` (required; a listed id or its base before `-`), `online` (default `false`), `allow_reset` (default `false` = one run: every `reset` is refused `RESET_DISABLED`; `true` allows resets) | observation (first frame full) |
| `act` | `session_id`, `action` (`ACTION1`–`ACTION7`), `x`/`y` (ACTION6 only, `0`–`COORD_MAX`), `reasoning` (≤ `REASONING_MAX_CHARS`), `frame` (`diff` default, `full`, `none`, `image`), `image_scale`/`image_grid` (`frame:"image"` only; [Board image](#board-image)), `animation` (`last` default, `all`; [Animation](#animation)) | observation |
| `reset` | `session_id`, `reasoning`, `frame` (`full` default, `diff`, `none`, `image`), `image_scale`/`image_grid` | observation |
| `observe` | `session_id`, `frame` (`full` default, `none`, `image`), `image_scale`/`image_grid`, `animation` (`last` default, `all`), `animation_step` (integer, `0`–`SESSION_STEPS_MAX`, default the latest step), `animation_from` (integer ≥ 0, default 0); the last two apply to `animation:"all"` only | observation from the stored last step; no toolkit call; with `animation:"all"` also the stored animation of `animation_step` ([Animation](#animation)) |
| `end_session` | `session_id` | `{session_id, game_id, steps, final:{state, levels_completed, win_levels, scorecard}, scorecard_url?, warnings?:[{code, detail, note}]}` |
| `list_sessions` | `scope` (`mine` default, `all`), `offset` (integer ≥ 0, skips that many of the newest) | `{scope, total, sessions:[…]}`, newest first from `offset` on; `total` = sessions in scope; an entry always carries `allow_reset` (boolean). json lists every session in scope; text shows `LIST_SESSIONS_TEXT_PAGE` per call and says `call list_sessions with offset: <n>` for the rest |
| `note` | `session_id`, `note` (1–`NOTE_MAX_CHARS`, not blank after trimming) | `{session_id, run}`: opens run `k+1`; json-format steps on the session record it until the next note ([scripted-play.md](scripted-play.md)). Gating: `SESSION_UNKNOWN` → `SESSION_ENDED` → `HUMAN_SESSION` → `NOT_OWNER` → `INVALID_ARGUMENT` → `TOO_MANY_NOTES` → `STEP_RATE_LIMITED` |

Text view per tool: `list_games` → a line per game; observations → the observation text below; `end_session` → final state, scorecard lines, `scorecard_url`, a `warning <code>: …` line per warning; `list_sessions` → one line per session; `note` → a line naming the run opened.

- `reasoning` on `act` reaches the toolkit as `{"text": <reasoning>}`; on `reset` it is recorded for the viewer only (the toolkit's `reset()` takes none).
- `mine` = sessions whose owner `sessionId` equals the caller's (both `null` counts as equal).
- `owner.kind` is `agent` or `human` (a person's session, started in the view); a meta without `kind` is an agent's. A human and an agent never act on each other's sessions: an agent's `act`, `reset`, `end_session` and `note` on a human session are refused `HUMAN_SESSION`, the view's on an agent session `AGENT_SESSION`. `observe` and `list_sessions` `scope:"all"` still show human sessions (`owner.kind:"human"`); `mine` never includes them.
- Among agents, ownership is a collision guard: `NOT_OWNER` only when owner and caller `sessionId` are both known and differ.
- `format` also decides how a step is recorded: a json call's `act`/`reset` (and `start_session`'s `START`) is `source:"script"`, a text call's is `source:"tool"` ([scripted-play.md](scripted-play.md)).

### Observation result

json: `structured` is the object below. text: the same data as prose: a header line (`Session <id>: <game_id> "<title>" (<mode>, <status>)`), `state … · levels_completed a/b · step n`, `available_actions: …`, an `allow_reset: true|false` line (always), conditional lines (`full_reset`, `status ended (end_reason …)`, `online: scorecard_url … · idle_close_at …`), `frame_count n`, a frame line, then the labelled grid ([Frame text](#frame-text)). With `frame:"image"` the text gives `Board image: <path>, open it with Read.` (or why there is none) and the image is a file: a result never carries image bytes.

| `structured` field | Meaning |
|---|---|
| `session_id`, `game_id`, `title` | `game_id` is the toolkit's resolved, versioned id |
| `mode` | `local` or `online` |
| `allow_reset` | boolean, always present; `false` = one run (every `reset` refused) |
| `status` | `live` or `ended` (`end_reason` present when ended) |
| `state` | `NOT_PLAYED`, `NOT_FINISHED`, `WIN`, `GAME_OVER` |
| `levels_completed`, `win_levels` | progress |
| `available_actions` | e.g. `["ACTION1","ACTION6"]`; on an `allow_reset:false` session never `RESET`, and `[]` in `WIN`/`GAME_OVER` |
| `step` | `0` = start; increments per `act`/`reset` |
| `frame_count` | frames the action produced; `frame` is the last one, the others come with `animation:"all"` ([Animation](#animation)) |
| `full_reset` | the last reset restarted the whole game |
| `frame` | by `mode`: `{mode:"full", rows}` (`rows`: hex row strings, `null` with no stored frame; plus `auto_full:true` when a `diff` was asked and there was no previous frame to compare); `{mode:"diff", changed_cells, bbox:{x0,y0,x1,y1}\|null, changed_rows:[{y, row}]}` (every changed row, however many); `{mode:"none"}`; for `frame:"image"`: `{mode:"image", path}` (absolute path of the PNG), `{mode:"image", unavailable:"no_frame"}` (no frame stored), `{mode:"image", unavailable:"session_ended"}` (it ended during the call), or `{mode:"image", error}` (the file could not be written; the action still happened). `changed_cells` = cells that differ between the previous step's last frame and this one's (animation frames in between are not counted); `bbox` = the smallest box (inclusive) covering every changed cell, status-bar cells included |
| `online` | online sessions: `{scorecard_url, idle_close_at}` (ISO time) |
| `animation` | only with `animation:"all"`: [Animation](#animation) |

The observation schema is written out in each of `act`, `reset`, `observe` and `start_session` (the manifest has no `$ref`); `tests/manifest.test.mjs` pins the copies equal. Toolkit-sourced numbers are typed `number` and `state` a plain string, so a toolkit value never makes cc reject a reply (`PLUGIN_REPLY_INVALID`).

### Frame text

- Two header lines: `xx|` + each column's tens digit, then `xx|` + its units digit. No line starts with whitespace; column `x` is at index `3 + x` on every line.
- Each row: `yy|` + one hex digit per cell = the palette index (`0`–`f`). `x` = column, `y` = row, origin top-left.
- `diff`: the header plus only changed rows (full row content). No change → `no cells changed`. More than `DIFF_MAX_ROWS` changed rows, or no comparable previous frame → sent full with `auto_full`. `DIFF_MAX_ROWS` is a text-view bound only: the json `diff` frame always lists every changed row (`frameData` in `src/frames.js`).
- No frame → the observation text says `No frame stored.`; `frame:"none"` → no frame line and no grid.

### Board image

`frame:"image"` on `act`, `reset` or `observe` renders the observation's frame to a PNG file and gives its absolute path (`frame.path` in json, named in the text); the agent opens it with its Read tool. Names written as `palette`, `scale.*` and `grid.*` below are keys of `src/board_image.json`, the single source for the image's numbers and colours, read by `src/boardImage.js`. `FRAME_SIDE` is the largest frame side, `COORD_MAX + 1` from `src/limits.js`.

| Option | Values | Default |
|---|---|---|
| `image_scale` | integer, `scale.min`–`scale.max` pixels per cell (a contact sheet caps it at `sheet.scale_max`, see [Animation](#animation)) | `scale.default` |
| `image_grid` | boolean: lines, ticks and labels | `grid.default` |

- Either option without `frame:"image"` → `INVALID_ARGUMENT` before any toolkit call. Out-of-bounds values → `INVALID_ARGUMENT` (schema). The manifest schemas carry no `default` for them (a schema default would be filled in by `validate()` and hide a stray option); `tests/manifest.test.mjs` pins the bounds and the described defaults to the spec.
- Live sessions only: `observe` with `frame:"image"` on an ended session → `SESSION_ENDED` (`frame:"full"` still works).
- Largest image: `grid.margin + FRAME_SIDE·scale.max` pixels a side.

**File lifecycle:** `<data dir>/images/<sid>/step-<n>-<seq>.png` (0600, dirs 0700), `n` = the observation's `step`, `seq` = a per-session counter, so every image has a path of its own (a reader never gets a cached older copy). Only the newest file per session is kept: each write unlinks the one file the backend wrote before it, nothing else. `images/` and each session dir must be real directories (a symlink or other file in their place makes the write fail with `frame.error`, writing nothing and changing no mode), and a session dir's realpath must sit directly under `images/`'s. The session's dir is removed when the session ends (every end path) and all of `images/` when the backend starts.

**Pixel rules** (PNG: 8-bit RGB, colour type 2, no alpha, not interlaced, filter 0 on every row). `rows` = H×W hex rows, 1 ≤ H, W ≤ `FRAME_SIDE`, rectangular; `s` = scale; `g` = grid on; `M = g ? grid.margin : 0`.

- Size: `(M + W·s) × (M + H·s)`. Pixels outside the image are never drawn (labels near an edge are clipped).
- Margin (`x < M` or `y < M`): `grid.margin_rgb`.
- Board pixel `(px, py)`: cell `(⌊(px−M)/s⌋, ⌊(py−M)/s⌋)`, coloured `palette[digit]`.
- Lines (`g` only): for each `c = grid.every·k`, `k ≥ 1`, `c < W`, the board pixel column `px = M + c·s` is a vertical line; for `c < H`, the board pixel row `py = M + c·s` a horizontal one. A line pixel is drawn only where `⌊along/grid.dash⌋` is even, `along` = its offset from the board origin along the line (`py − M` vertical, `px − M` horizontal), in `grid.contrast[digit of the cell under it]` (so crossings don't depend on drawing order).
- Ticks (`g` only): for each `c = grid.every·k`, `k ≥ 0`: columns `c < W` → pixels `px = M + c·s`, `py ∈ [M − grid.tick_len, M)`; rows `c < H` → the same in the left margin (`px ∈ [M − grid.tick_len, M)`, `py = M + c·s`); colour `grid.label_rgb`.
- Labels (`g` only): the decimal digits of each ticked `c`. Origin: top margin `(M + c·s + grid.label_offset, grid.label_offset)`; left margin `(grid.label_offset, M + c·s + grid.label_offset)`. Digit `i` starts at `origin.x + i·(glyph width + 1)·grid.font_scale`; each `#` at glyph cell `(gx, gy)` of `grid.glyphs[digit]` fills the `grid.font_scale`-square block at `(digit.x + gx·grid.font_scale, origin.y + gy·grid.font_scale)` with `grid.label_rgb`.
- Rendering fails loudly (throws / raises) on ragged rows, a non-hex digit, a shape outside 1–`FRAME_SIDE` or an option out of bounds.
- `palette` is `arc_agi.rendering.COLOR_MAP` without alpha (pinned to `frontend/palette.js` by `tests/boardImage.test.mjs`, to the toolkit by the gated real-toolkit test). `grid.contrast` is stored in the spec; it was derived from `palette` by the rule "black where palette colour `i` has `0.299R + 0.587G + 0.114B ≥ 128`, else white", which `tests/boardImage.test.mjs` re-checks.

### Animation

An animating action returns several grids; `frame` always means the last one. `animation:"all"` on `act` or `observe` adds an `animation` field (and, in text, a section after the frame text). Without it nothing is added: the output is byte-identical to a call without the argument (`tests/fixtures/act-default.json`, `tests/animation-mcp.test.mjs`).

- **Which step:** `act` returns the animation of the step it just took (`animation.step` = the result's `step`, built from the toolkit reply, no disk read). `observe` returns `animation_step` (default the latest). It reads the stored step: not a step, so no toolkit call, no `STEP_RATE_LIMITED` slot, no step line, and it works on ended sessions. `frame:"none"` returns only the animation.
- **Indexes** are the toolkit's: stored leading frames are `0..k-1`, the last frame is `frame_count - 1`. A jump in `index` is a gap.
- **Stored frames:** at most `ANIMATION_FRAMES_MAX` per step (`src/limits.js`, mirrored in `sidecar/engine.py`): the first `ANIMATION_FRAMES_MAX - 1` and the last; `frame_count` stays true. `omitted = frame_count - stored`. Steps recorded before animations were stored have only their last frame (`stored: 1`, text: `Earlier frames were not recorded`); a START step has `stored: 1`, `omitted: 0`.
- **Paging:** at most `ANIMATION_PAGE_MAX` frames per call, from the first stored frame with `index >= animation_from`. `truncated: true` and `next_from` (the next stored index) say more is left; the text names `observe` with `animation:"all"`, `animation_step` and `animation_from:<next_from>`.
- **json** `animation` = `{step, frame_count, stored, omitted, from, next_from, truncated, frames:[…]}`. The first frame of the page is `{index, mode:"full", rows}`; each later one `{index, mode:"diff", changed_cells, bbox, changed_rows}` against the frame before it (a change of shape gives `mode:"full", auto_full:true`). A terminal step with no frame gives `frames: []`. The top-level `frame`'s `changed_cells` remains last-to-last of steps.
- **text:** a header line (step, `frame_count`, stored, shown indexes), then `frame <i> (full|diff, …):` with the grid (`DIFF_MAX_ROWS` applies as in [Frame text](#frame-text)), then the gap notice (`Frames a-b were not stored …`; `No readable frames were recorded for this step` when none could be read) and the `truncated:` line.
- **Contact sheet:** with `frame:"image"` the frames go into one PNG instead: `animation.image` = `{path}` | `{unavailable:"no_frame"|"session_ended"}` | `{error}` and no `frames`; the board image is still written. Tiles are the board render of each frame under its `index` label, `sheet.columns` per row, `sheet.gap` apart and around (`sheet` in `src/board_image.json`; renderer `renderSheet` in `src/boardImage.js`). `image_scale` (default `sheet.scale_default`) and `image_grid` apply to the tiles. Values of `image_scale` above `sheet.scale_max` render at `sheet.scale_max` (bounds the render cost); board images keep the full `scale` range. The file is `<data dir>/images/<sid>/anim-<n>-<seq>.png` (`n` = the animation's step, `seq` shared with the board images). Each kind (board, sheet) keeps only its newest file per session; a sheet write never removes the board image. `observe` with an image on an ended session → `SESSION_ENDED`.
- **Refusals:** `animation_step`/`animation_from` without `animation:"all"` → `INVALID_ARGUMENT`; `animation_step` past the latest step, or a step that cannot be read → `STEP_UNKNOWN` (`details: {step}`, the latest step); `animation_from > 0` at or past `frame_count` → `INVALID_ARGUMENT` (`details: {frame_count}`).

### Refusals

`{error, code, details?}` in both formats: `error` is the human reason, `code` is below, and `details` is an object holding the code's extra keys (the table's last column), omitted when there are none. Envelope-level codes: `TOOL_UNKNOWN` (unknown tool), `INVALID_ARGUMENT` (malformed request, unknown `format`, schema violation), `INTERNAL` (a handler threw).

Gating order for `act`: `SESSION_UNKNOWN` → `SESSION_ENDED` → `HUMAN_SESSION` (view callers: `AGENT_SESSION`) → `NOT_OWNER` → `SESSION_BUSY` → `SESSION_STALLED` → toolkit state → `INVALID_ARGUMENT` → `GAME_FINISHED` → `ACTION_UNAVAILABLE` → `SESSION_STEP_LIMIT` → `STEP_RATE_LIMITED` → `RATE_LIMITED`. `reset`: the same without the action checks, plus `RESET_DISABLED` after toolkit state (before `INVALID_ARGUMENT`). Schema refusals, image options without `frame:"image"`, and animation options without `animation:"all"`, come before all of these.

| Code | When | `details` keys |
|---|---|---|
| `INVALID_ARGUMENT` | schema violation; ACTION6 without `x`/`y`, or `x`/`y` on another action; `image_scale`/`image_grid` without `frame:"image"`; `animation_step`/`animation_from` without `animation:"all"`; `animation_from` past the last frame (`details.frame_count`); `reasoning` over the toolkit's byte bound as the toolkit measures it (ASCII-escaped JSON; double-encoded online) | `detail` (sidecar checks) |
| `SESSION_UNKNOWN` | no such session | |
| `SESSION_ENDED` | session ended; also `observe` with `frame:"image"` on an ended session | `end_reason` |
| `SESSION_BUSY` | another call on the session is in flight | |
| `SESSION_STALLED` | an earlier call timed out and hasn't answered | |
| `HUMAN_SESSION` | an agent acted on, noted on or ended a session a person started in the view | |
| `AGENT_SESSION` | the view's play routes on an agent's session | |
| `NOT_OWNER` | owner and caller `sessionId` both known and different (collision guard, not auth) | |
| `TOO_MANY_SESSIONS` | `MAX_LIVE_SESSIONS` live | `live` (ids) |
| `GAME_UNKNOWN` | not in `list_games`, or the toolkit can't find it (with a bundle and no network, games outside the bundle are not listed: a local start of one gets a `detail` saying the web game list could not be fetched) | `detail` (bundle case only) |
| `ACTION_UNAVAILABLE` | action not in `available_actions` | `available_actions` |
| `GAME_FINISHED` | non-RESET action in `WIN`/`GAME_OVER`; on an `allow_reset:false` session the reason says the run is over (call `end_session`) | `state` (plus `allow_reset:false` on such a session) |
| `RESET_DISABLED` | any `reset` on an `allow_reset:false` session; never sent, no step recorded, no rate budget spent (online included). A finished online run left live is closed by the idle sweep after `ONLINE_IDLE_CLOSE_MS`, so `end_session` promptly | `allow_reset:false` |
| `TOOLKIT_NOT_READY` | venv still being checked/installed (or stopped); or, for `start_session`, an API key change in progress (`state:"reconfiguring"`) | `state`, `phase` |
| `TOOLKIT_UNAVAILABLE` | venv install failed, or the offline bundle was rejected ([bundle.md](bundle.md)) | `detail` (≤ `DETAIL_MAX`), `fix` |
| `DEPS_DIVERGED` | worktree's symlinked `.venv` doesn't match its `requirements.txt` | `detail`, `fix` |
| `TOOLKIT_TIMEOUT` | no answer within the op's `DEADLINES` entry; the session becomes stalled | `detail` |
| `TOOLKIT_ERROR` | any other toolkit failure; arcprize.org refusing the API key (401/403) is this code with a detail that says so | `detail` |
| `SIDECAR_EXITED` | the sidecar died; live sessions end with `sidecar_exit` | `detail` (redacted stderr tail) |
| `NETWORK_ERROR` | timeout / connection failure reaching arcprize.org; also `start_session` `online:true` for a game outside the offline bundle while the web game list can't be fetched | `detail` |
| `RATE_LIMITED` | local guard for `ONLINE_RPM_LIMIT` (not sent), or a 429 from arcprize.org | `retry_after_ms` (local guard) |
| `STEP_RATE_LIMITED` | the session took `STEP_RATE_MAX` steps in the last `STEP_RATE_WINDOW_MS` (`act`/`reset` in either format, and `note`); refused, never delayed, not sent | `retry_after_ms` |
| `STEP_UNKNOWN` | `observe` with `animation:"all"` and an `animation_step` that is past the latest step or whose stored line cannot be read | `step` (the latest) |
| `SESSION_STEP_LIMIT` | `act`/`reset` on a session whose step count reached `SESSION_STEPS_MAX`; `end_session` and start a new one | |
| `TOO_MANY_NOTES` | `note` past `NOTES_MAX` notes on the session (json steps still play under the last run) | |
| `SCORECARD_CLOSED` | arcprize.org no longer knows the game/scorecard; the session ends with `scorecard_auto_closed` | `detail` |

`end_reason` values: `ended_by_agent`, `ended_by_user` (ended from the view), `scorecard_auto_closed`, `sidecar_exit`, `backend_restart`.

## HTTP API

Paths are relative to the plugin root (`/plugins/code-arc/` inside cc). Every response carries the headers in `SECURITY_HEADERS` (`src/http.js`). Non-GET routes require `content-type: application/json` (else 415) and a same-origin `Sec-Fetch-Site` (else 403; without that header, any `Origin` is refused).

| Route | Behaviour |
|---|---|
| `GET api/health` | `{ok:true}`; independent of the toolkit (`healthPath`) |
| `GET api/status` | `{toolkit:{state, phase, detail, fix, python, code, source, bundle}, sidecar:{running, versions}}`; toolkit `state` ∈ `checking`, `installing`, `ready`, `failed`, `diverged`, `stopped`; `fix` is set for `failed` and `diverged`; `source` ∈ `web`, `bundle`, `null`; `bundle` is `null` or `{location, path, id, created_at, target, toolkit, games, shadowed}` (`id` `null` for a rejected bundle; [bundle.md](bundle.md)) |
| `GET api/sessions?before&limit` | `{sessions:[meta…], total, next}`: newest first, at most `SESSIONS_PAGE_MAX`, starting after the session id `before` (400 if malformed); `next` is the `before` for the following page, `null` at the end; `total` counts every stored session |
| `GET api/sessions/:id` | meta; 404 `SESSION_UNKNOWN` |
| `GET api/sessions/:id/steps?from&limit` | `{steps:[…]}` with `n ≥ from`, at most `STEPS_PAGE_MAX` |
| `GET api/sessions/:id/steps/:n/frames` | `{n, frame_count, stored, omitted, frames:[{index, rows}]}`: every stored frame of step `n` (at most `ANIMATION_FRAMES_MAX`), for the viewer's animation replay; 404 `SESSION_UNKNOWN` or `STEP_UNKNOWN` |
| `GET api/sessions/:id/notes` | `{notes:[…]}`, every run note of the session in run order (at most `NOTES_MAX`); 404 `SESSION_UNKNOWN` |
| `GET api/events` | SSE (below) |
| `GET api/settings` | `{apiKey:{set, masked}}` — never the key |
| `PUT api/settings/api-key` | body `{key}` → `{apiKey}`; 400 `INVALID_KEY` (value not echoed); 409 `SESSIONS_ACTIVE` while any session is live or starting; 409 `KEY_CHANGE_IN_PROGRESS` while another key change is being saved. Error bodies are `{error, code}`; `error` is the reason to show the user |
| `DELETE api/settings/api-key` | clears → `{apiKey}`; the same 409s |
| `GET api/games` | human play: `{games, web_unavailable?}` (= `list_games` json); refusals as below |
| `POST api/sessions` | human play: start a session ([Human play routes](#human-play-routes)) |
| `POST api/sessions/:id/act` | human play: one action |
| `POST api/sessions/:id/reset` | human play: reset |
| `POST api/sessions/:id/end` | human play: end |
| `POST api/mcp` | the MCP endpoint |

Static files: an allowlist of `frontend/` files (`src/static.js`); everything else, including `/pluginBridge.js` and `/pluginTheme.css`, is a real 404.

### Human play routes

The view starts and plays its own sessions through the same session-service methods as the MCP tools (`src/play.js`, `src/sessions.js`), so every gate and limit applies unchanged: live cap, `STEP_RATE_MAX`, `SESSION_STEPS_MAX`, `RESET_DISABLED`, toolkit state, the ONLINE limiter, key-change blocking. The caller is `HUMAN` (`source:"human"`); only these routes produce it (`handle` in `src/mcp.js` sets `source` from `format` alone, so a `caller.source` in an MCP body is ignored). Non-GET routes need the same-origin JSON guard above.

| Route | Body (other keys → 400 `INVALID_ARGUMENT`) | 200 body |
|---|---|---|
| `POST api/sessions` | `{game_id, online?, allow_reset?}` (bounds from the `start_session` input schema) | the observation without `ok` and `frame`, plus `title` |
| `POST api/sessions/:id/act` | `{action, x?, y?}` (`ACTION1`–`ACTION7`; no `reasoning`, `frame` or `session_id`) | same observation body |
| `POST api/sessions/:id/reset` | `{}` | same observation body |
| `POST api/sessions/:id/end` | `{}` | `{session_id, game_id, steps, final, scorecard_url?, warnings?}` (= `end_session` json) |

- A path id that is not a session id → 404 `SESSION_UNKNOWN`. Bad JSON → 400 `BAD_JSON`; oversize → 413.
- A refusal is `{error, code, details?}` as in MCP, with the HTTP status from `REFUSAL_STATUS` in `src/play.js`:

| Status | Codes |
|---|---|
| 400 | `INVALID_ARGUMENT`, `GAME_UNKNOWN` |
| 403 | `AGENT_SESSION` |
| 404 | `SESSION_UNKNOWN` |
| 429 | `STEP_RATE_LIMITED`, `RATE_LIMITED` |
| 503 | `TOOLKIT_NOT_READY`, `TOOLKIT_UNAVAILABLE`, `DEPS_DIVERGED` |
| 502 | `TOOLKIT_ERROR`, `TOOLKIT_TIMEOUT`, `SIDECAR_EXITED`, `NETWORK_ERROR` |
| 409 (every other code) | `SESSION_ENDED`, `SESSION_BUSY`, `SESSION_STALLED`, `GAME_FINISHED`, `ACTION_UNAVAILABLE`, `RESET_DISABLED`, `TOO_MANY_SESSIONS`, `SESSION_STEP_LIMIT`, `SCORECARD_CLOSED` |

- Human steps are recorded `source:"human"`; ending records `end_reason:"ended_by_user"`. The routes act only on sessions with `owner.kind:"human"` (`AGENT_SESSION` otherwise).

### Session meta

`{id, game_id, title, mode, allow_reset, owner:{kind, sessionId, project}, scorecard_id, scorecard_url, status, end_reason, stalled, created_at, updated_at, last_activity_at, step_count, last:{state, levels_completed, win_levels, available_actions, frame_count, full_reset}, final?}`

- `allow_reset` is missing on legacy metas: read it as `true` (`api/sessions` and SSE serve the raw meta; tool outputs always carry the resolved boolean).

### Step

`{n, ts, action:"START"|"RESET"|"ACTIONn", source:"tool"|"script"|"human", run?, x?, y?, reasoning?, state, levels_completed, win_levels, available_actions, frame_count, full_reset, frame:[hex rows]|null}`

- `source` is missing on steps recorded before scripting existed: read it as `tool`. `source:"script"` = a json-format call; `run` is set only on a script step taken after a note (a script step before the first note has none).
- Step pages and the SSE `step` event carry the last frame only, never the animation (`anim`/`anim_z`); the frames route above serves it.
- On disk a step line carries `frame_z` (base64 raw deflate of the rows joined by `\n`) instead of `frame`; every API and SSE step has `frame` rows. Lines with a plain `frame` still read. A corrupt or tampered stored frame reads as `frame: null` ([architecture.md](architecture.md) → On-disk state).

### Note

`{run, ts, text, from_step}`: the note that opened run `run` (the `note` tool); `from_step` = the session's step count + 1 when it was written. A step whose toolkit reply arrives late is recorded under the run current when it was issued, so a late reply from an earlier run can land at or after a later run's `from_step`. Stored in `sessions/<sid>/notes.jsonl`; `text` is stored as sent (untrimmed).

### SSE events (`api/events`)

| Event | Data |
|---|---|
| `status` | the `api/status` body; first on every connection, again on changes |
| `sessions` | the newest page, same shape as `GET api/sessions` (`{sessions, total, next}`); second on every connection. Older sessions: `GET api/sessions?before=<next>` |
| `session` | one session meta (create/update) |
| `step` | `{session_id, step}` |
| `note` | `{session_id, note}` (a program opened a run) |

At most `SSE_MAX_CLIENTS` connections: a new one evicts the most backed-up connection, else the oldest. The preference protects a viewer only from stalled or backed-up clients; a client that keeps opening fresh connections (no backlog) still evicts by age and is limited only by `SSE_MAX_CLIENTS` turnover. A client that is still behind from an earlier write (no drain yet) with more than `SSE_MAX_BUFFERED_BYTES` unsent is disconnected; one large write (the initial state) never trips this on its own. Event ids are `<boot>-<n>`; a reconnect with `Last-Event-ID` (or `?lastEventId=`) replays missed events from a small ring. `: ping` keepalives.

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

`obs` = `{state, levels_completed, win_levels, available_actions:[int], full_reset, frame_count, frame:[hex rows]|null, anim:[[hex rows], …]}`: `frame` is the last frame, validated to the palette and to `FRAME_MAX` in `sidecar/engine.py` (a bad one refuses). `anim` is the leading frames, oldest first: all of them up to `ANIMATION_FRAMES_MAX` frames, else the first `ANIMATION_FRAMES_MAX - 1`. A leading frame that fails the same validation empties `anim` (stderr warning) without refusing, because the toolkit has already applied the action.
