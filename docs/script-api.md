# Script HTTP API

Contracts for scripted play: the routes an agent's Python script calls, and the bundled client. Refusal codes, the step and note shapes and SSE events are in [protocol.md](protocol.md); bounds are named by their constant in `src/limits.js`.

Same session service as the MCP tools: the same gating, refusal codes, step log and SSE events. Script steps are recorded with `source:"script"` and the run they belong to.

**Where:** `meta.script` from `start_session` (or `script_access`'s result) = `{base_url, token, client}`.

- `base_url` = the backend's own address, `http://127.0.0.1:<port>/api/play/<session_id>/` (not cc's proxy). The port changes only when the plugin restarts, which ends every session anyway.
- `client` = the absolute path of `clients/code_arc.py` in the plugin checkout.
- `token` = 32 random bytes, base64url. Kept in backend memory only (as its sha256) while its session is live; dropped when the session ends, by any path. A script call to an ended session (including every session after a backend restart) answers `SESSION_ENDED` + `end_reason` before any token check: status and end reason are public through `GET api/sessions/:id` anyway.
- The token appears only in the `start_session` and `script_access` tool results (themselves `api/mcp` responses): never in the store, steps, notes, SSE, the viewer's `api/sessions*` routes, other tool results, or logs.
- `script_access` rotates it only for a caller whose `sessionId` is a non-empty string equal to the session owner's; a session started by an unidentified caller (owner `null` or `""`) can't be rotated (`NOT_OWNER`). See [protocol.md](protocol.md) → MCP tools.

**Every request:** `POST <base_url><op>` with

- `content-type: application/json` (else 415);
- no `Origin` and no `Sec-Fetch-Site` header (else 403 `CROSS_SITE`, "script routes are for non-browser clients"; even the same-origin viewer can't call them);
- `Authorization: Bearer <token>` (the header only, never the query or body; at most `SCRIPT_AUTH_HEADER_MAX` characters);
- a body of at most `BODY_MAX_BYTES` that parses as JSON (else the router errors below), then validated against the op's flat schema (unknown keys, wrong types or bounds → `INVALID_ARGUMENT`) once the session and token gates have passed.

A session id that isn't `s-` + 12 hex digits is 404 `SESSION_UNKNOWN`; a well-formed unknown id is the 200 refusal `SESSION_UNKNOWN`.

| op | body | ok result |
|---|---|---|
| `attach` | `{note}` (1–`NOTE_MAX_CHARS`, not blank after trimming) | observation + `run` (a new run, which supersedes any other) |
| `act` | `{run, action, x?, y?, reasoning?}` (same bounds as the `act` tool) | observation + `run` |
| `reset` | `{run, reasoning?}` | observation + `run` |
| `note` | `{run, note}` | `{ok:true, run}` (the new run) |
| `observe` | `{}` | observation (from the stored last step; no toolkit call) |

- **Runs:** a run is the segment opened by one note. `attach` opens run `k`; `note` opens `k+1`. `act`/`reset`/`note` must name the current run: none open → `NOTE_REQUIRED`, an older one → `RUN_SUPERSEDED`. Runs never expire; tool steps in between don't end one. `script_access` closes the current run (run numbers keep counting).
- **Board images:** the script routes have no image option; a script renders locally with `Observation.save_png`.
- **Observation** (200): `{ok:true, session_id, game_id, mode, allow_reset?, status, end_reason?, state, levels_completed, win_levels, available_actions:["ACTIONn"…], step, frame_count, full_reset, frame:[hex rows]|null, online?, run?}`: the MCP `meta` fields minus `title` and the frame-text `frame` mode, with the raw rows.
- **Refusal** (200): `{ok:false, code, reason, …extra}` with the MCP codes. `TOKEN_INVALID` is HTTP 401 with the same body.
- **Router errors** keep the `{error, code}` shape: 400 `BAD_JSON`, 413 `BODY_TOO_LARGE`, 415, 403 `CROSS_SITE`, 404, 405.

**Gating order:**

Every op starts with the same pre-schema gate, then the body schema: `SESSION_UNKNOWN` → `SESSION_ENDED` → `TOKEN_INVALID` → `INVALID_ARGUMENT` (schema). Then:

- `act`: `NOTE_REQUIRED` / `RUN_SUPERSEDED` → `SESSION_BUSY` → `SESSION_STALLED` → toolkit state → `INVALID_ARGUMENT` → `GAME_FINISHED` → `ACTION_UNAVAILABLE` → `SESSION_STEP_LIMIT` → `STEP_RATE_LIMITED` → `RATE_LIMITED`. `reset`: the same without the action checks, plus `RESET_DISABLED` after toolkit state.
- `attach`: `INVALID_ARGUMENT` (blank note) → `TOO_MANY_NOTES` → `STEP_RATE_LIMITED`. No busy or stalled check (no toolkit call).
- `note`: `NOTE_REQUIRED` / `RUN_SUPERSEDED`, then as `attach`.
- `observe`: nothing more.

The token replaces ownership: a script call is never `NOT_OWNER`. Tool callers are still owner-checked.

## Python client (`clients/code_arc.py`)

Stdlib only, Python ≥ 3.8; import it from the directory of `meta.script.client`. Usage example in its module docstring. `save_png` reads `board_image.json` from the client's own directory: the two files must stay side by side.

| Name | Behaviour |
|---|---|
| `Session.attach(base_url, token, note, timeout=60)` | POSTs `attach`; keeps `.run`, `.session_id`, `.last` |
| `.act(action, x=None, y=None, reasoning=None)`, `.reset(reasoning=None)`, `.observe()` | send the current run where needed; return an `Observation` |
| `.note(text)` | opens the next run; updates and returns `.run` |
| `Observation` | `.session_id`, `.step`, `.status`, `.end_reason`, `.state`, `.levels_completed`, `.win_levels`, `.available_actions` (list of str), `.frame_count`, `.full_reset`, `.grid` (64×64 `list[list[int]]` or `None`), `.online`, `.allow_reset` (default `True`), `.raw` |
| `Observation.save_png(path, scale=None, grid=None)` | renders `.grid` as a board image PNG at `path` (atomic: temp file in the target dir, then rename) and returns its absolute path; `None` = the spec default; `ValueError` with no frame, `scale` not an int (bools refused) or outside the spec bounds, `grid` not a bool. Same pixels as the MCP `frame:"image"` (rules: [protocol.md](protocol.md) → Board image) |
| `Refusal` | any `ok:false` body, or a 4xx `{error, code}`: `.code`, `.reason`, `.extra` (dict), `.retry_after_ms` (or `None`) |
| `TransportError` | unreachable, non-JSON body, a body over `MAX_RESPONSE_BYTES`, or 5xx; the message names `base_url` |

No retries of any kind. HTTP proxies from the environment are bypassed (the backend is local).
