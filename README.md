# Code ARC

A [code-conductor](https://github.com/UnmanagedCode/code-conductor) plugin that lets agents play **ARC-AGI-3** games through the official `arc-agi` toolkit, while you watch: the live frame, every action, the agent's reasoning, and a replay scrubber.

- **For agents:** MCP tools (`code-arc__list_games`, `code-arc__start_session`, `code-arc__act`, …) plus a `play-arc` skill that teaches good play. Scripted play goes through cc's `run_code`.
- **For you:** a **Code ARC** view in cc with the session list, the game frame in the ARC palette, the action log, the reasoning per step, replay, and animations that play automatically across the step interval, or start a game and play it yourself from the view.
- **Settings:** your ARC API key (optional; without one the toolkit's anonymous key is used).

Details: [docs/features.md](docs/features.md) (what you can do) · [docs/protocol.md](docs/protocol.md) (tools, refusal codes, HTTP API, wire formats) · [docs/scripted-play.md](docs/scripted-play.md) (scripted play through `run_code`) · [docs/architecture.md](docs/architecture.md) (internals, on-disk state, tests) · [docs/bundle.md](docs/bundle.md) (bundle: install and games without the web).

## Quick start

1. Enable the plugin in cc (**Settings → Plugins**). On first start the backend builds its Python venv in the background (about a minute on a cold cache); the view shows a banner until the toolkit is ready. To build it ahead of time: `node scripts/setup.mjs` in the plugin checkout.
2. Optional: open **Code ARC → Settings** and paste an API key from [arcprize.org](https://arcprize.org).
3. Ask any agent: *"play an ARC game"* and watch it in the **Code ARC** view, or click **New game** and play it yourself.

Standalone (no cc): `CONDUCTOR_PLUGIN_DATA_DIR=/abs/data/dir PORT=8791 node server.js`, then open `http://127.0.0.1:8791/`.

## Key defaults

| What | Default | Where it lives |
|---|---|---|
| Play mode | Local (toolkit NORMAL mode: games downloaded and run locally, in-memory scorecard) | `start_session` `online:true` opts one session into arcprize.org ONLINE mode |
| Resets | off (one run: reset refused `RESET_DISABLED`) | `start_session` `allow_reset:true` opts one session in |
| Frame returned by `act` | changed rows only (`diff`) | `frame` argument |
| Animation returned by `act`/`observe` | last frame only; the `animation` argument adds at most `ANIMATION_PAGE_MAX` frames per call | `animation` argument; `src/limits.js` |
| Live sessions | capped | `MAX_LIVE_SESSIONS` in `src/limits.js` |
| Reasoning length | capped, plus the toolkit's own byte bound | `REASONING_MAX_CHARS` in `src/limits.js`; `MAX_REASONING_BYTES` in `arcengine` |
| Online rate limit / idle close | refused locally / session ended | `ONLINE_RPM_LIMIT`, `ONLINE_IDLE_CLOSE_MS` in `src/online.js` |
| Step rate per session (all steps and notes) | refused with `STEP_RATE_LIMITED` | `STEP_RATE_MAX` per `STEP_RATE_WINDOW_MS` in `src/limits.js` |
| Steps per session | refused with `SESSION_STEP_LIMIT` | `SESSION_STEPS_MAX` in `src/limits.js` |
| State | `$CONDUCTOR_PLUGIN_DATA_DIR` only | `src/store.js` |

## Stack

- Node ≥ 22 backend with **zero npm dependencies** (`node:http`, `node:test`); vanilla ES-module frontend, no build step.
- A Python sidecar (`sidecar/`) drives the `arc-agi` toolkit in a venv the backend builds itself (`requirements.txt`, fully pinned).
- Tests: `npm test` (Node + Python, no network, fake toolkit). Visual check: `node harness/playwright/screenshot.mjs`.

## Changing dependencies (worktrees)

Worktrees share the main checkout's `.venv` (and `node_modules`, `.wiki`) through symlinks made by the main checkout's post-worktree-create hook. **A worktree that changes `requirements.txt` must first replace its symlink with its own venv:**

```bash
rm .venv && node scripts/setup.mjs
```

The backend enforces this: a symlinked `.venv` whose pins differ puts the toolkit in the `diverged` state (banner, `DEPS_DIVERGED` refusals) and is never written through. Same rule for npm deps if any are ever added: `rm node_modules && npm install`.

## Bundle (no-web install)

For a host without network: on a machine with network run `node scripts/bundle.mjs export` (writes `bundles/code-arc-<time>.arcbundle`, gitignored; prints the bundle id), copy the file over, then `CONDUCTOR_PLUGIN_DATA_DIR=/abs/data/dir node scripts/bundle.mjs import <file> --expect-sha256 <id>` (or extract it and set `CODE_ARC_BUNDLE=/abs/dir`) and restart the plugin. The venv then installs from the bundle with no download, and the bundle's games play locally with no network; online play is unchanged.

**Licensing:** the bundle holds game sources downloaded from arcprize.org, for which ARC publishes no license. It is for your own environments: never commit, publish or share it. Details, trust model and limits: [docs/bundle.md](docs/bundle.md).

## Security notes

- **Local mode runs game code from arcprize.org.** The toolkit downloads each game's Python source and executes it (its NORMAL-mode design) inside the sidecar process, as your user, with the sidecar's cwd inside the plugin data dir. A hostile game could therefore read anything that process can, **including the API key** the sidecar holds in memory and the files your user can read. For a game you don't trust, start it with `online:true`: ONLINE mode runs the game on arcprize.org and never executes its code locally.
- **The API key** is stored at `<data dir>/secrets.json` (mode 0600) and shown only masked. The backend sends it to the sidecar over stdin (never env or argv) and redacts it from the logs and tool results it produces; that protects against accidental leaks, not against code running inside the sidecar (above). Changing it requires no live or starting sessions.
- The backend binds `127.0.0.1` only; every response carries a strict CSP; non-GET routes require same-origin JSON.

## Known limitations

- A step stores at most `ANIMATION_FRAMES_MAX` animation frames (the first ones and the last); steps recorded before animations were stored have only their last frame.
- Steps are stored compressed and capped per session (`SESSION_STEPS_MAX`); there is still no retention across sessions: every session's steps stay in the data dir until you delete them.
- Scripted play uses cc's `run_code`, which cc refuses (`SCRIPT_UNAVAILABLE_REMOTE`) for a session whose project lives on a remote System; those workers play with the tools directly.
- The **script** badge follows cc's json format: a json MCP client that isn't a `run_code` program shows as script.
- `requirements.txt` pins versions but not hashes (wheels are platform-specific).
- A game you started in the view stays live (holding a live slot and blocking API key changes) until you end it there; local sessions never idle-close.
- Live sessions end when the backend restarts (toolkit environments are in-process).
- Online sessions need network, are rate-limited, and their scorecards auto-close after idling; arcprize.org's server-side reasoning bound is checked conservatively.
- **DNS rebinding is not blocked** (inherited from code-conductor's posture). The backend accepts any `Host` header: cc's plugin proxy forwards the browser's `Host` (localhost, LAN address, remote or tunnel name), so an allowlist would break the view for those users, and code-conductor itself documents DNS rebinding as a known, out-of-scope limitation of its own `/api` (its `docs/protocol.md` → WebSocket protocol → Handshake: Origin check), which a rebinding page could use to reach far more than this plugin. The same-origin JSON, `Sec-Fetch-Site` and `Origin` guards stay.
- The viewer loads at most the newest `VIEWER_STEPS_MAX` steps of a session (`frontend/app.js`).
