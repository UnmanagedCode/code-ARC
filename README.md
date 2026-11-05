# Code ARC

A [code-conductor](https://github.com/UnmanagedCode/code-conductor) plugin that lets agents play **ARC-AGI-3** games through the official `arc-agi` toolkit, while you watch: the live frame, every action, the agent's reasoning, and a replay scrubber.

- **For agents:** MCP tools (`code-arc__list_games`, `code-arc__start_session`, `code-arc__act`, …) plus a `play-arc` skill that teaches good play.
- **For you:** a **Code ARC** view in cc with the session list, the game frame in the ARC palette, the action log, the reasoning per step, and replay.
- **Settings:** your ARC API key (optional; without one the toolkit's anonymous key is used).

Details: [docs/features.md](docs/features.md) (what you can do) · [docs/protocol.md](docs/protocol.md) (tools, refusal codes, HTTP API, wire formats) · [docs/architecture.md](docs/architecture.md) (internals, on-disk state, tests).

## Quick start

1. Enable the plugin in cc (**Settings → Plugins**). On first start the backend builds its Python venv in the background (about a minute on a cold cache); the view shows a banner until the toolkit is ready. To build it ahead of time: `node scripts/setup.mjs` in the plugin checkout.
2. Optional: open **Code ARC → Settings** and paste an API key from [arcprize.org](https://arcprize.org).
3. Ask any agent: *"play an ARC game"*. Watch it in the **Code ARC** view.

Standalone (no cc): `CONDUCTOR_PLUGIN_DATA_DIR=/abs/data/dir PORT=8791 node server.js`, then open `http://127.0.0.1:8791/`.

## Key defaults

| What | Default | Where it lives |
|---|---|---|
| Play mode | Local (toolkit NORMAL mode: games downloaded and run locally, in-memory scorecard) | `start_session` `online:true` opts one session into arcprize.org ONLINE mode |
| Frame returned by `act` | changed rows only (`diff`) | `frame` argument |
| Live sessions | capped | `MAX_LIVE_SESSIONS` in `src/limits.js` |
| Reasoning length | capped, plus the toolkit's own byte bound | `REASONING_MAX_CHARS` in `src/limits.js`; `MAX_REASONING_BYTES` in `arcengine` |
| Online rate limit / idle close | refused locally / session ended | `ONLINE_RPM_LIMIT`, `ONLINE_IDLE_CLOSE_MS` in `src/online.js` |
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

## Security notes

- **Local mode runs game code from arcprize.org.** The toolkit downloads each game's Python source and executes it (its NORMAL-mode design) inside the sidecar process, as your user, with the sidecar's cwd inside the plugin data dir. A hostile game could therefore read anything that process can, **including the API key** the sidecar holds in memory and the files your user can read. For a game you don't trust, start it with `online:true`: ONLINE mode runs the game on arcprize.org and never executes its code locally.
- **The API key** is stored at `<data dir>/secrets.json` (mode 0600) and shown only masked. The backend sends it to the sidecar over stdin (never env or argv) and redacts it from the logs and tool results it produces; that protects against accidental leaks, not against code running inside the sidecar (above). Changing it requires no live or starting sessions.
- The backend binds `127.0.0.1` only; every response carries a strict CSP; non-GET routes require same-origin JSON.

## Known limitations

- Agents see only the **last** frame of a multi-frame action (`frame_count` says how many there were).
- No retention policy: every step (one frame each) stays in the data dir until you delete it.
- `requirements.txt` pins versions but not hashes (wheels are platform-specific).
- Live sessions end when the backend restarts (toolkit environments are in-process).
- Online sessions need network, are rate-limited, and their scorecards auto-close after idling; arcprize.org's server-side reasoning bound is checked conservatively.
- **DNS rebinding is not blocked** (inherited from code-conductor's posture). The backend accepts any `Host` header: cc's plugin proxy forwards the browser's `Host` (localhost, LAN address, remote or tunnel name), so an allowlist would break the view for those users, and code-conductor itself documents DNS rebinding as a known, out-of-scope limitation of its own `/api` (its `docs/protocol.md` → WebSocket protocol → Handshake: Origin check), which a rebinding page could use to reach far more than this plugin. The same-origin JSON, `Sec-Fetch-Site` and `Origin` guards stay.
- The viewer loads at most the newest `VIEWER_STEPS_MAX` steps of a session (`frontend/app.js`).
