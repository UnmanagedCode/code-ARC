# Architecture

```
cc ──POST /api/mcp──▶ Node backend (server.js, src/) ──JSON lines──▶ Python sidecar (sidecar/, .venv, arc_agi)
cc proxy ─/plugins/code-arc/─▶ same backend: frontend/, api/*, SSE
                                └── $CONDUCTOR_PLUGIN_DATA_DIR: secrets.json, sessions/, toolkit/
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
| `src/sidecar.js` | Owns the Python child: spawn, protocol, deadlines, late replies, redaction, respawn |
| `src/sessions.js` | Session service: lifecycle, ownership, gating, online limits, idle sweep, SSE publishing |
| `src/mcp.js` | Tool handlers, schema validation against the manifest, result shaping |
| `src/frames.js` | Frame text (full / diff) |
| `src/online.js` | ONLINE limits, rate limiter, scorecard URL |
| `src/store.js` | The only session writer; `src/keyStore.js` the key; `src/atomicFile.js` helpers |
| `src/sse.js` | SSE hub with a replay ring |
| `sidecar/arc_sidecar.py` | Protocol loop, fd isolation, logging and redaction, a thread per request |
| `sidecar/engine.py` | Toolkit adapter: one `Arcade` per mode, the environments, failure classification, reasoning byte check |
| `frontend/` | Vanilla ES modules, no build: `app.js` (state, routing, SSE), `grid.js`, `sessions.js`, `steplog.js`, `settings.js`, `palette.js`, `safeHref.js`, `api.js` |
| `claude/` | Claude Code plugin with the `play-arc` skill |

## Lifecycle

- **Start:** `store.init()` loads every session (a `live` one becomes `ended`/`backend_restart`), the HTTP server listens, and `bootstrap.run()` starts in the background. Health and the UI answer throughout.
- **First toolkit call:** `sidecar.call()` spawns `<python> -I -u sidecar/arc_sidecar.py` in its own process group, cwd `<data>/toolkit/`, with an env allowlist (`ENV_ALLOWLIST` in `src/sidecar.js`); waits for `ready`, then sends `configure` with the key from `keyStore`.
- **Each call** has a deadline from `DEADLINES`. On timeout the session is marked `stalled`; the eventual reply is applied (`lateHandler` in `src/sessions.js`) and un-stalls it.
- **Sidecar exit** (crash, oversized line): pending calls resolve `SIDECAR_EXITED`, live sessions end with `sidecar_exit`, the next call respawns. A deliberate `sidecar.stop()` (key change, shutdown) ends no sessions.
- **Starts and key changes share one in-process gate** (`start` / `changeKey` in `src/sessions.js`). A start checks the live cap and reserves a slot in one synchronous block, and holds the reservation until the store has the session. A key change runs only with nothing live or starting and no other key change (`KEY_CHANGE_IN_PROGRESS`); it clears the cached game list (it depends on the key) and blocks starts (`TOOLKIT_NOT_READY`, `state:"reconfiguring"`) while it writes the key and stops the sidecar, so the next spawn configures the new key.
- **Shutdown:** `app.close()` stops the sweep, the bootstrap (`bootstrap.stop()` kills a running venv/pip step's process group and settles the bootstrap as `stopped`), the sidecar and the SSE clients.
- **Live events are bounded** (`src/sse.js`): at most `SSE_MAX_CLIENTS` connections, a newcomer evicting the most backed-up connection, else the oldest (a stuck connection can't lock the viewer out, and a busy local client can't keep evicting it); a client is dropped only when it is still undrained from an earlier write and over `SSE_MAX_BUFFERED_BYTES`, so a large initial burst alone never drops it. The initial `sessions` event is one page (`SESSIONS_PAGE_MAX`); the viewer fetches older pages on demand. A dropped EventSource reconnects and resumes from the replay ring.
- **Online idle sweep:** every `SWEEP_MS` (`src/sessions.js`, injected timers), a live online session idle for `ONLINE_IDLE_CLOSE_MS` ends with `scorecard_auto_closed` and is dropped from the sidecar.

## The venv bootstrap (`src/bootstrap.js`)

- `.venv/code-arc-stamp.json` = `{requirements_sha256, python_version}`, written **last**; a matching stamp means ready.
- States: `checking` → `installing` (phases `python`, `venv`, `download`, `install`, `smoke`) → `ready`; or `failed` (`code`: `PYTHON_MISSING`, `DOWNLOAD_FAILED`, `HASH_MISMATCH`, `VENV_FAILED`, `INSTALL_FAILED`, `SMOKE_FAILED`) or `diverged`, each with a `fix` (`FIX`, `DIVERGED_FIX`) carried in the status, the refusals and the viewer banner; or `stopped` (shutdown mid-install).
- Steps: find a Python of at least `MIN_PYTHON` among `PYTHON_CANDIDATES` → `python -m venv --without-pip .venv` → download the pip zipapp (`PIP_PYZ_URL`, verified against `PIP_PYZ_SHA256`) → `pip.pyz install -r requirements.txt` → `import arc_agi, arcengine` → stamp.
- **A symlinked `.venv` is never written through:** stamp mismatch → `diverged`. Fix in that worktree: `rm .venv && node scripts/setup.mjs`.
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

The directories and files the plugin itself creates are 0700 / 0600: the data dir, `sessions/` and everything in it, `toolkit/` itself, and `secrets.json`. What the toolkit creates under `toolkit/` (`environment_files/` and the downloaded games) keeps the toolkit's own modes, typically 0755 / 0644.

```
secrets.json                 {arcApiKey}
sessions/<sid>/meta.json     session meta (atomic writes)
sessions/<sid>/steps.jsonl   one step per line, append-only
toolkit/                     sidecar cwd: the toolkit's environment_files/ (downloaded games), .env lookup
```

The latest frame per session is cached in memory and rebuilt on start from the tail of `steps.jsonl`.

## Tests

- `npm test` = `node tests/run.mjs` (node:test API, files serial) + `python3 -I -m unittest discover -s sidecar/tests -t .`. No network.
- Node tests run the **real sidecar** on the system `python3` against the **fake toolkit** in `sidecar/tests/fakes/` (`CODE_ARC_PYTHON=python3`, `CODE_ARC_TEST_TOOLKIT_DIR`). The fake mirrors the toolkit's signatures and failure shapes, records every call to `<data>/toolkit/calls.jsonl` (the key as its sha256), and ships games that hang, crash, print, rate-limit or lose their scorecard.
- Each test gets a fresh data dir and projects root (`freshEnv` in `tests/_helpers.mjs`); clocks, timers, deadlines, the online limit, spawn and fetch are injected through `createApp`.
- Real toolkit smoke test (network, bootstrapped `.venv`): `RUN_REAL_ARC=1 python3 -m unittest sidecar.tests.test_real_toolkit`. It also checks `frontend/palette.js` against `arc_agi.rendering.COLOR_MAP`.
- Visual check: `node harness/playwright/screenshot.mjs` (needs `CC_PROJECTS_ROOT` and the code-playwright plugin) boots a sandboxed server on the fake toolkit, drives the viewer and writes PNGs to `harness/playwright/out/`.
