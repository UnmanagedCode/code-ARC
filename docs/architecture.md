# Architecture

```
cc ──POST /api/mcp──▶ Node backend (server.js, src/) ──JSON lines──▶ Python sidecar (sidecar/, .venv, arc_agi)
cc proxy ─/plugins/code-arc/─▶ same backend: frontend/, api/*, SSE
agent script (clients/code_arc.py) ─127.0.0.1:<port>/api/play/─▶ same backend (no cc hop)
                                └── $CONDUCTOR_PLUGIN_DATA_DIR: secrets.json, sessions/, images/, toolkit/
```

## Components

| Module | Responsibility |
|---|---|
| `server.js` | Entry: config, listen on `127.0.0.1:$PORT`, SIGTERM/SIGINT → `app.close()` |
| `src/config.js` | Env → config; requires an absolute `CONDUCTOR_PLUGIN_DATA_DIR`; never reads `PROJECTS_ROOT` |
| `src/app.js` | Wires everything; `createApp({config, clock, timers, spawn, fetch, log, …})` returns `{server, close()}` |
| `src/limits.js` | Every bound; the manifest schemas are pinned to it by `tests/manifest.test.mjs` |
| `src/http.js` | Security headers, bounded JSON bodies, cross-site guard, router, `clientError` |
| `src/static.js` | Frontend file allowlist |
| `src/bootstrap.js` | Builds `.venv` (state machine below) |
| `src/bundle.js` | Offline bundle policy: locations, manifest schema, path allowlist, `BUNDLE_LIMITS`, the one verifier (`verifyBundle`), install args ([bundle.md](bundle.md)) |
| `src/tar.js` | Streaming POSIX ustar writer (pax `path` record for long file names) and fail-closed reader (files, directories and that one pax form only) |
| `src/bundleImport.js` | `importBundle`: untrusted archive → staging → verify → atomic rename into `<data>/bundle` |
| `src/bundleExport.js` | `exportBundle`: pip, wheels and games into a verified `.arcbundle` |
| `src/proc.js` | Child runner shared by the bootstrap and export: deadlines, process-group kill, `stopAll`, captured stdout |
| `src/sidecar.js` | Owns the Python child: spawn, protocol, deadlines, late replies, redaction, respawn |
| `src/sessions.js` | Session service: lifecycle, ownership and script-token gating, online and step limits, runs and notes, idle sweep, SSE publishing |
| `src/mcp.js` | Tool handlers: format dispatch (`json`/`text`), schema validation against the manifest, refusal → `{error, code, details}`, view pairs (only the requested view is built) |
| `src/toolText.js` | The text view: prose renderers over the json data, `list_sessions` text paging |
| `src/schema.js` | `validate`: the flat schema subset, shared by the MCP handlers and the script routes |
| `src/observation.js` | `observationFields`: the observation fields both surfaces return (MCP adds title and frame, scripts the raw rows; MCP json drops `ok`) |
| `src/scriptAccess.js` | In-memory script tokens (sha256, constant-time verify) and runs per session; no I/O |
| `src/scriptRoutes.js` | `POST api/play/:id/<op>` ([script-api.md](script-api.md)): script guard, bearer parse, pre-schema session/token gate (`sessions.admitScript`), per-op schemas, result shaping |
| `src/frames.js` | Frame text (full / diff) and the json frame data (`diffRows`, `frameData`) |
| `src/png.js` | `encodePng`: minimal PNG encoder (RGB, filter 0, one IDAT, table CRC); knows nothing about ARC |
| `src/boardImage.js` | `renderBoard` / `boardPng`: frame rows → board image pixels by the rules in [protocol.md](protocol.md) → Board image; `IMAGE_SPEC` (the parsed spec, validated at load) |
| `src/boardImages.js` | `createBoardImages`: board image files of live sessions (`write`, `prune`, `init`); per-session serialised, latest only, path-checked |
| `clients/board_image.json` | The board image spec (palette, scale bounds, grid geometry, glyphs): read by `src/boardImage.js` and `clients/code_arc.py`; next to the client so scripts find it |
| `src/online.js` | ONLINE limits, rate limiter, scorecard URL |
| `src/store.js` | The only session writer (board image files aside: `src/boardImages.js`); `src/keyStore.js` the key; `src/atomicFile.js` helpers |
| `src/sse.js` | SSE hub with a replay ring |
| `sidecar/arc_sidecar.py` | Protocol loop, fd isolation, logging and redaction, a thread per request |
| `sidecar/engine.py` | Toolkit adapter: one `Arcade` per mode (plus an OFFLINE arcade over a bundle's games), the environments, failure classification, reasoning byte check |
| `sidecar/bundle_games.py` | Export helper (never run by the backend): downloads every listed game into a bundle's `games/` |
| `scripts/bundle.mjs` | Bundle CLI: `export`, `import` |
| `frontend/` | Vanilla ES modules, no build: `app.js` (state, routing, SSE), `playback.js` (`createPlayback`: the shown step and Live/Replay mode, injected clock, no DOM), `grid.js`, `sessions.js`, `steplog.js`, `runs.js` (pure script-run helpers), `settings.js`, `palette.js`, `safeHref.js`, `api.js` |
| `clients/code_arc.py` | Stdlib-only Python client for the script HTTP API, handed to agents as `script.client` from `start_session` |
| `claude/` | Claude Code plugin with the `play-arc` skill |

## Lifecycle

- **Start:** `store.init()` loads every session (a `live` one becomes `ended`/`backend_restart`), `images.init()` empties `images/` (nothing in it can belong to a live session, and it clears temp files of a crashed write), the HTTP server listens, and `bootstrap.run()` starts in the background. Health and the UI answer throughout.
- **First toolkit call:** `sidecar.call()` spawns `<python> -I -u sidecar/arc_sidecar.py` in its own process group, cwd `<data>/toolkit/`, with an env allowlist (`ENV_ALLOWLIST` in `src/sidecar.js`); waits for `ready`, then sends `configure` with the key from `keyStore`.
- **Each call** has a deadline from `DEADLINES`. On timeout the session is marked `stalled`; the eventual reply is applied (`lateHandler` in `src/sessions.js`) and un-stalls it.
- **Sidecar exit** (crash, oversized line): pending calls resolve `SIDECAR_EXITED`, live sessions end with `sidecar_exit`, the next call respawns. A deliberate `sidecar.stop()` (key change, shutdown) ends no sessions.
- **Starts and key changes share one in-process gate** (`start` / `changeKey` in `src/sessions.js`). A start checks the live cap and reserves a slot in one synchronous block, and holds the reservation until the store has the session. A key change runs only with nothing live or starting and no other key change (`KEY_CHANGE_IN_PROGRESS`); it clears the cached game list (it depends on the key) and blocks starts (`TOOLKIT_NOT_READY`, `state:"reconfiguring"`) while it writes the key and stops the sidecar, so the next spawn configures the new key.
- **Shutdown:** `app.close()` stops the sweep, the bootstrap (`bootstrap.stop()` kills a running venv/pip step's process group and settles the bootstrap as `stopped`), the sidecar and the SSE clients.
- **Live events are bounded** (`src/sse.js`): at most `SSE_MAX_CLIENTS` connections, a newcomer evicting the most backed-up connection, else the oldest (the backlog preference protects the viewer only from stalled or backed-up clients; a local process that keeps opening fresh connections, each with no backlog, still evicts by age, oldest first, and is limited only by `SSE_MAX_CLIENTS` turnover); a client is dropped only when it is still undrained from an earlier write and over `SSE_MAX_BUFFERED_BYTES`, so a large initial burst alone never drops it. The initial `sessions` event is one page (`SESSIONS_PAGE_MAX`); the viewer fetches older pages on demand. A dropped EventSource reconnects and resumes from the replay ring.
- **Script tokens** live only in `src/scriptAccess.js`'s memory: minted by `start_session` (rotated by `script_access`), they die with the process, like the sessions they open. Contracts: [script-api.md](script-api.md).
- **Ending a session prunes its in-memory entries:** `end()` in `src/sessions.js` (every path: `end_session`, idle sweep, sidecar exit, `SCORECARD_CLOSED`, a session the toolkit lost) deletes its `runtime` entry and its script token and runs, and queues `images.prune(id)` (a failed prune is logged, never fails the end). Nothing re-creates them: every gate refuses an ended session first, and a late reply for an ended session returns before touching `runtime`. The script API's `base_url` is built from `server.address().port` when a session starts.
- **Board images vs session end:** `src/boardImages.js` runs a session's writes and prune on one promise chain, and a write checks `isLive` when its turn comes. `end()` marks the meta ended synchronously before it queues the prune, so a write either lands before the prune (which removes it) or sees the session ended and resolves `{ended:true}` without writing. No image outlives its session.
- **Board images vs planted symlinks:** game code runs as the user with its cwd under the data dir, so it can put a symlink where `images/` or `images/<sid>` goes. A write `lstat`s both and refuses unless each is a real directory, chmods them only through an `O_NOFOLLOW | O_DIRECTORY` descriptor, and requires the session dir's realpath to sit directly under `images/`'s. Latest-only unlinks the one path remembered in-process for the session (never a directory listing). `prune` refuses when `images/` is not a real directory; a symlink in a session dir's place is unlinked by `fs.rm` and its target kept. A swap in the instant after a check is not closed (Node has no `openat`): between the write's checks and the PNG write, between `prune`'s check and its recursive `fs.rm`, and before the latest-only `unlink`, so a game that wins the race can redirect those operations, and a lost race can leave PNGs and orphan `.tmp` files outside the data dir. Such a game can already write and delete anywhere the user can.
- **Per-session step rate:** a sliding-window limiter per session (`rt(id).steps`, `createRateLimiter` with `windowMs`) shared by tool and script steps.
- **Viewer under a burst:** live steps append one row each; past `VIEWER_STEPS_MAX` the oldest row is trimmed (O(1)); the shown step is paced by `createPlayback` (`frontend/playback.js`), which owns the cursor and mode, while rendering is coalesced to one per animation frame (its `onChange` is `scheduleRender`, so appends in one synchronous batch never paint a transient cursor); a reconnect fetches only `steps?from=<last n + 1>` (a full reload only when the gap is over `VIEWER_STEPS_MAX`). Live steps that arrive while steps load wait in a buffer and are applied after the load.
- **Online idle sweep:** every `SWEEP_MS` (`src/sessions.js`, injected timers), a live online session idle for `ONLINE_IDLE_CLOSE_MS` ends with `scorecard_auto_closed` and is dropped from the sidecar.

## The venv bootstrap (`src/bootstrap.js`)

- `.venv/code-arc-stamp.json` = `{requirements_sha256, python_version}`, written **last**; a matching stamp means ready.
- States: `checking` (phases `bundle`, `stamp`) → `installing` (phases `python`, `venv`, `download`, `install`, `smoke`) → `ready`; or `failed` (`code`: `PYTHON_MISSING`, `DOWNLOAD_FAILED`, `HASH_MISMATCH`, `VENV_FAILED`, `INSTALL_FAILED`, `SMOKE_FAILED`, `BUNDLE_INVALID`, `BUNDLE_HASH_MISMATCH`, `BUNDLE_STALE`, `BUNDLE_PLATFORM_MISMATCH`) or `diverged`, each with a `fix` (`FIX`, `DIVERGED_FIX`) carried in the status, the refusals and the viewer banner; or `stopped` (shutdown mid-install).
- Steps: find a Python of at least `MIN_PYTHON` among `PYTHON_CANDIDATES` → `python -m venv --without-pip .venv` → download the pip zipapp (`PIP_PYZ_URL`, verified against `PIP_PYZ_SHA256`) → `pip.pyz install -r requirements.txt` → `import arc_agi, arcengine` → stamp.
- **A symlinked `.venv` is never written through:** stamp mismatch → `diverged`. Fix in that worktree: `rm .venv && node scripts/setup.mjs`.
- **Offline bundle** ([bundle.md](bundle.md)): `bundle` locations (`config.bundle`, from `bundleLocations`) are located and verified first, every boot, also under `CODE_ARC_PYTHON`; the install then uses the bundle's pip and wheels (`--no-index`, no `download` phase), after a target check against the interpreter. Status gains `source` and `bundle`; `bootstrap.gamesDir()` hands `<bundle>/games` to the sidecar's `configure`. `start_session` turns the sidecar's `web_unavailable` into `NETWORK_ERROR` (online) or a `GAME_UNKNOWN` detail (local) for an id outside the bundle (`src/sessions.js`).
- `CODE_ARC_PYTHON` skips the bootstrap (test seam); `node scripts/setup.mjs` runs the same bootstrap in the foreground.
- To bump pip: update `PIP_VERSION` and `PIP_PYZ_SHA256` together (download the zipapp, `sha256sum` it).

## Sidecar isolation and redaction

- At startup the sidecar dups fd 1 for the protocol and points fd 1 at fd 2; `sys.stdout`/`sys.stderr` become a redacting writer. Toolkit prints and the toolkit's stdout log handlers land on stderr.
- Our logger (`code_arc.toolkit`, WARNING) is passed to every `Arcade`; `arc_agi.scorecard`'s handlers are replaced with ours after the toolkit is imported.
- Redaction (sidecar `Redactor`, Node `redact` in `src/sidecar.js`): the configured key, the toolkit's resolved key (`Arcade.arc_api_key`), and any `Got anonymous API key: …` line.
- `list_games` fails rather than returning an empty list when `Arcade()` logged a failed `/api/games` fetch (the toolkit only logs it), and drops that arcade so the next call retries; an arcade cached with an empty list is rebuilt once per call, never twice.
- A 401/403 from arcprize.org is `TOOLKIT_ERROR` with a detail naming the API key (`AUTH_HINT`).
- Failures are classified (`classify_failure` in `sidecar/engine.py`) from the exception the toolkit raised or logged with `exc_info` (HTTP status and body, exception class), then from message text.

## On-disk state (`$CONDUCTOR_PLUGIN_DATA_DIR`)

The directories and files the plugin itself creates are 0700 / 0600: the data dir, `sessions/` and `images/` and everything in them, `toolkit/` itself, and `secrets.json`. What the toolkit creates under `toolkit/` (`environment_files/` and the downloaded games) keeps the toolkit's own modes, typically 0755 / 0644.

```
secrets.json                 {arcApiKey}
sessions/<sid>/meta.json     session meta (atomic writes)
sessions/<sid>/steps.jsonl   one step per line, append-only; frames as `frame_z`
sessions/<sid>/notes.jsonl   one script run note per line, append-only
images/<sid>/step-<n>-<seq>.png  newest board image of a live session (0600); removed at session end, all of images/ at start
toolkit/                     sidecar cwd: the toolkit's environment_files/ (downloaded games), .env lookup
bundle/                      the imported offline bundle (bundle.md); read-only to the toolkit
```

- The latest frame per session is cached in memory and rebuilt on start from the tail of `steps.jsonl` (`TAIL_READ_BYTES` in `src/store.js`).
- A step line stores its frame as `frame_z` = base64 of `deflateRawSync(rows.join('\n'))`, stateless per line (on a recorded 69-step game, about 480 B against 4.2 KB of plain rows per frame); `decodeStep` inflates it, and lines with a plain `frame` still read. `n` is the first key of every line, so `readSteps` skips earlier lines by the `{"n":<n>,` prefix without parsing them.
- `SESSION_STEPS_MAX` bounds a session's `steps.jsonl`; there is no retention across sessions.
- Reading back, `frame_z` is inflated with `maxOutputLength` at one frame's text; a frame that fails to inflate, overflows the bound, or isn't 1–64 rows of 1–64 hex digits reads as `frame: null` (a tampered or corrupt line never crashes a read).

## Tests

- `npm test` = `node tests/run.mjs` (node:test API, files serial) + `python3 -I -m unittest discover -s sidecar/tests -t .` + the same for `clients/tests` (the client against a threaded `http.server` fake). No network.
- Scripted play: `tests/script.test.mjs` (the HTTP contract, runs, auth, limits, token secrecy), `tests/scriptClient.test.mjs` (spawns `python3 -I tests/fixtures/client_driver.py` against `startApp`). The `stepRate` seam on `createApp` (`{max, windowMs}`) lifts the per-session step rate for tests that act back to back.
- MCP formats: `tests/mcp-formats.test.mjs` covers every tool in both formats (refusal parity, `format` dispatch, `list_sessions` paging, frame content). The `mcp` helper from `startApp` sends `format:'json'` and returns the raw reply; unwrap it with `ok(r)` (asserts the reply is exactly `{structured}` and validates it against the manifest `outputSchema`) or `refusal(r, code)`; `mcpText` sends `format:'text'`. `tests/_jsonSchemaSubset.mjs` is a test-only port of cc's `checkSchema`/`validate`.
- Node tests run the **real sidecar** on the system `python3` against the **fake toolkit** in `sidecar/tests/fakes/` (`CODE_ARC_PYTHON=python3`, `CODE_ARC_TEST_TOOLKIT_DIR`). The fake mirrors the toolkit's signatures and failure shapes, records every call to `<data>/toolkit/calls.jsonl` (the key as its sha256), and ships games that hang, crash, print, rate-limit, lose their scorecard or end in GAME_OVER (`fake-lose`).
- Each test gets a fresh data dir and projects root (`freshEnv` in `tests/_helpers.mjs`); clocks, timers, deadlines, the online limit, spawn and fetch are injected through `createApp`.
- Offline bundle: `tests/_bundle.mjs` builds bundle dirs with real hashes, archives (also malformed ones) and a refusing fetch spy. The fake toolkit logs every request it would send to `<data>/toolkit/net.jsonl` (`{path, mode, ok}`) and fails them all while `<data>/toolkit/fake-net-down` exists; its OFFLINE mode scans a games dir and records `load_source`. `tests/bundle-boot.test.mjs` boots whole apps on that switch.
- Board images: `tests/boardImage.test.mjs` decodes with the independent test decoder `tests/_png.mjs` and proves server/client parity by spawning `python3 -I tests/fixtures/png_driver.py <clients dir> <out dir>` (JSON cases `[{rows, scale, grid, out}]` on stdin) and comparing every pixel with `renderBoard`; `tests/boardImages.test.mjs` covers the file lifecycle. Sample image for a visual check: `node harness/board-image.mjs [--scale N] [--no-grid]` boots the backend in-process on a fresh temp data dir and the fake toolkit, plays two moves, prints `{path, data_dir}` and leaves the session (and its image) in place; delete the printed data dir afterwards.
- Real toolkit smoke test (network, bootstrapped `.venv`): `RUN_REAL_ARC=1 python3 -m unittest sidecar.tests.test_real_toolkit`. It also checks `frontend/palette.js` and the `clients/board_image.json` palette against `arc_agi.rendering.COLOR_MAP`, and that an OFFLINE arcade plays a downloaded game with every socket call guarded (`sidecar/tests/netguard.py`, test-only).
- Viewer pacing and replay: `tests/playback.test.mjs` drives `createPlayback` on a fake clock (burst pacing, jump to latest, trim, play/pause/seek, mode switch, interval change). `tests/http.test.mjs` pins that an ended session's steps stay readable.
- Visual check: `node harness/playwright/screenshot.mjs` (needs `CC_PROJECTS_ROOT` and the code-playwright plugin) boots a sandboxed server on the fake toolkit, drives the viewer and writes PNGs to `harness/playwright/out/` (including `paced-behind.png` and `replay.png`). Its script scenario boots `harness/playwright/server.mjs`, which is `server.js` with a raised step rate for a 300-step burst. `node harness/playwright/bundle.mjs` boots on a fixture bundle (`CODE_ARC_BUNDLE`) and on a tampered one: `bundle-ready.png`, `bundle-rejected.png`.
