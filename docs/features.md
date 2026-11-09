# Features

## The Code ARC view

- **Session list** (newest first; the newest page loads at once, **Load older sessions** fetches more): game title, `local`/`online` badge, status (`Live`, `Stalled`, or how it ended), step and state, and who is playing — the cc session id (shortened) and project, or "unknown caller". Inside cc, **Open session** jumps to the playing agent's session (when it is live).
- **Header strip:** game, state, levels as `completed/total`, mode, and for online sessions a **Scorecard on arcprize.org** link. Badges for a stalled session and for "Scorecard auto-closed by arcprize.org (15 min idle)".
- **Frame:** the 64×64 grid in the ARC palette, scaled crisply. Hover a cell to see `x,y = value`.
- **Live and Replay modes:** a **Live | Replay** switch next to the scrubber.
  - **Live** (the default) shows every step in order, each held on screen for at least the interval, so a script firing at the rate cap plays in slow motion. While the shown step lags the newest, the viewer says "N steps behind" and offers **Jump to latest**. A step arriving more than an interval after the previous one shows at once.
  - **Replay** has **Play/Pause**, previous/next and the scrubber. Play advances one step per interval and stops at the last step; Play at the last step restarts from the first loaded step. Play is disabled in Live.
  - Manual navigation (scrubber, previous/next, an **Action log** row, a deep link) enters Replay, paused. **Live** jumps to the newest step and paces only later arrivals; a session opened without a `step` shows its newest step directly (recorded history is not paced).
  - **Interval:** a slider from `INTERVAL_MIN_MS` to `INTERVAL_MAX_MS` in `INTERVAL_STEP_MS` steps (`frontend/playback.js`), default `DEFAULT_INTERVAL_MS`, with its value shown beside it; it applies to both modes and is not kept across page loads.
  - **Animation:** a step with more than one frame plays its frames by itself, once, whenever it is selected: a Live arrival, a Replay Play advance, previous/next, an Action log row, a deep link, the scrubber, opening a session, **Live**, **Jump to latest**. Selecting the shown step again replays it. It never loops; the last frame holds.
    - **Timing:** the animation spans the interval as set at selection, so each frame lasts interval ÷ frame count (500 ms over 10 frames is one frame per 50 ms). Frames whose time has passed are skipped (never faster than one display frame), the last frame is always shown, and a stored gap holds the frame before it. Changing the interval mid-animation takes effect at the next selection. Playback pacing ignores animations; a new selection cancels the running one.
    - **Loading:** the next step's frames are fetched ahead of time. If the frames are not loaded when the step is selected, the canvas keeps the previous board (label `loading…`) and plays the remaining part once they arrive. If they do not arrive within the interval, or the fetch fails (`frames unavailable`), the step's last frame shows.
    - **Scrubber:** while dragging, each position shows its last frame; the position you release on (or each keyboard step) animates.
    - **Indicator:** a passive `frame i of N` label with the toolkit's frame index and a note when frames were not stored; there are no animation buttons. Single-frame steps show no line.
  - Ended sessions can be replayed. Replay covers the steps the viewer loaded (the newest `VIEWER_STEPS_MAX`, `frontend/app.js`).
- **Reasoning:** the selected step's reasoning, exactly as the agent wrote it. For a scripted step in a run, the note of its run comes first ("Run k note: …").
- **Scripted play:** steps a `run_code` program took carry a **script** badge in the action log, and each run starts with a **Script run k — <note>** header saying what the program tries and why. A script step taken before the program's first note has the badge and no header. The step summary says `script` or `tool`. Notes arrive live like steps.
- **Live updates:** new steps and session changes arrive as they happen, even from a script stepping at the rate cap (the action log gets each row at once; the shown step is paced, see Live mode); a reconnect fetches only what it missed.
- **Deep links:** the URL carries `?session=<id>&step=<n>`; pasting it reopens that step in Replay, paused. Live mode writes no `step`.
- **Toolkit banner:** shown while the toolkit is installing, or with the error and the fix when installing failed or the venv diverged (**Bundle rejected** for an offline bundle that failed verification).
- **Toolkit source:** the header says where the toolkit and games come from: `Toolkit and local games: bundle <id> (<n> games)` or `Toolkit and games: web`.
- Follows cc's light/dark theme (or the OS theme standalone) and cc's session width.

## Settings

- **ARC API key:** paste, **Save**, **Clear**. Shown only masked: the last four characters, or nothing for keys shorter than `TAIL_MIN_LENGTH` (`src/keyStore.js`). Empty means the toolkit's anonymous key.
- Changing the key is refused while any game session is live (end them first) or another change is still saving; the panel shows the server's reason.

## Agent tools

`list_games`, `start_session`, `act`, `reset`, `observe`, `end_session`, `list_sessions`, `note` — contracts in [protocol.md](protocol.md).

- Frames come as text (one hex digit per cell with coordinate headers); `act` sends only the changed rows by default, which keeps a typical move to a few lines.
- **Animations:** an action can animate (`frame_count > 1`); `frame` is always the last frame. An agent adds `animation:"all"` to `act`, or calls `observe` with `animation:"all"` and the `animation_step` from the `act` result, to get the frames: the first full, each later one a diff against the frame before, a page at a time (`truncated` and `next_from` say how to continue). With `frame:"image"` it gets one contact-sheet PNG of numbered tiles instead. Past `ANIMATION_FRAMES_MAX` frames a step stores the first ones and the last (the result says which indexes are missing); steps recorded earlier have only their last frame. Details: [protocol.md](protocol.md) → Animation.
- **Board images:** `frame:"image"` on `act`, `reset` or `observe` writes the frame as a PNG (palette colours, optional dashed grid with labelled coordinates every few cells) and returns its path; the agent opens it with Read. An image shows layout, shapes and symmetry for a fraction of a full text frame's tokens; text frames stay the way to read exact cells. Scripts get the same picture with `frame:"image"` and read the PNG path from `frame.path`. Options and file lifecycle: [protocol.md](protocol.md) → Board image.
- `online:true` on `start_session` plays against arcprize.org with a real scorecard (link in the result and the viewer). Rate limits and idle closes are reported as refusals, never retried silently.
- **One-run sessions:** Sessions are one run by default: every reset is refused (`RESET_DISABLED`); `allow_reset:true` on `start_session` allows resets. After `GAME_OVER` or a full win a one-run session stays live until `end_session`. The viewer marks a resettable session with a "Resets" badge, and shows a "Resets: on" / "Resets: off (one run)" header fact. The `play-arc` skill forbids learning a game from its source, bundles or toolkit internals.
- The tools serve cc's two result formats: json is the complete data (for `run_code` programs, via cc's REST alias), text is prose for agents; `list_sessions` text pages with `offset`, json lists every session. Contracts: [protocol.md](protocol.md) → MCP tools.
- Only the agent session that started a game can act on or end it; anyone can observe.
- **Agent scripting:** for sweeps, searches or replaying a route, an agent uses cc's `run_code`: a program calls `cc.code_arc.note` (what it tries and why), then `cc.code_arc.act`/`reset`, branches on the json results and returns a digest. Its steps go through the same checks and log as tool steps, recorded as scripted under the latest note. Each session takes at most `STEP_RATE_MAX` steps per `STEP_RATE_WINDOW_MS` and `SESSION_STEPS_MAX` steps in all (`src/limits.js`). `run_code` is unavailable for a session whose project lives on a remote System. Contracts: [scripted-play.md](scripted-play.md).

## Offline bundle

- Build one archive on a machine with network (`node scripts/bundle.mjs export`): the pinned pip, every wheel, every game's source. Import it on a host without network (`node scripts/bundle.mjs import`), or point `CODE_ARC_BUNDLE` at an extracted copy.
- With a bundle, the toolkit installs with no download, and local play of the bundle's games needs no network. `list_games` tags each game `source: bundle | web`; web games are added when the web is reachable.
- Online play is unchanged; without network it fails with `NETWORK_ERROR`.
- For your own environments only: ARC publishes no license for the games. Details: [bundle.md](bundle.md).

## The `play-arc` skill

Shipped as a Claude Code plugin (`claude/`), loaded into every cc session through the manifest's `claudePlugin`. It tells an agent how to probe unknown games, keep token use low (diffs, a board image when it needs the layout), write reasoning the user can follow, when to script with `run_code` and notes, and react to each refusal code.
