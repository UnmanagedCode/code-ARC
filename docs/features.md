# Features

## The Code ARC view

- **Session list** (newest first; the newest page loads at once, **Load older sessions** fetches more): game title, `local`/`online` badge, status (`Live`, `Stalled`, or how it ended), step and state, and who is playing — the cc session id (shortened) and project, or "unknown caller". Inside cc, **Open session** jumps to the playing agent's session (when it is live).
- **Header strip:** game, state, levels as `completed/total`, mode, and for online sessions a **Scorecard on arcprize.org** link. Badges for a stalled session and for "Scorecard auto-closed by arcprize.org (15 min idle)".
- **Frame:** the 64×64 grid in the ARC palette, scaled crisply. Hover a cell to see `x,y = value`.
- **Replay:** a scrubber with previous/next buttons and **Follow live** (on by default; it turns off when you scrub back). Clicking a row in the **Action log** jumps to that step.
- **Reasoning:** the selected step's reasoning, exactly as the agent wrote it. For a scripted step, the note of its run comes first ("Run k note: …").
- **Scripted play:** steps an agent's script took carry a **script** badge in the action log, and each run starts with a **Script run k — <note>** header saying what the script tries and why. The step summary says `script` or `tool`. Notes arrive live like steps.
- **Live:** new steps and session changes arrive as they happen, even from a script stepping at the rate cap; a reconnect fetches only what it missed.
- **Deep links:** the URL carries `?session=<id>&step=<n>`; pasting it reopens that step.
- **Toolkit banner:** shown while the toolkit is installing, or with the error and the fix when installing failed or the venv diverged (**Bundle rejected** for an offline bundle that failed verification).
- **Toolkit source:** the header says where the toolkit and games come from: `Toolkit and local games: bundle <id> (<n> games)` or `Toolkit and games: web`.
- Follows cc's light/dark theme (or the OS theme standalone) and cc's session width.

## Settings

- **ARC API key:** paste, **Save**, **Clear**. Shown only masked: the last four characters, or nothing for keys shorter than `TAIL_MIN_LENGTH` (`src/keyStore.js`). Empty means the toolkit's anonymous key.
- Changing the key is refused while any game session is live (end them first) or another change is still saving; the panel shows the server's reason.

## Agent tools

`list_games`, `start_session`, `act`, `reset`, `observe`, `end_session`, `list_sessions`, `script_access` — contracts in [protocol.md](protocol.md).

- Frames come as text (one hex digit per cell with coordinate headers); `act` sends only the changed rows by default, which keeps a typical move to a few lines.
- `online:true` on `start_session` plays against arcprize.org with a real scorecard (link in the result and the viewer). Rate limits and idle closes are reported as refusals, never retried silently.
- Only the agent session that started a game can act on or end it; anyone can observe.
- **Agent scripting:** for sweeps, searches or replaying a route, an agent writes a Python script with the bundled client (`clients/code_arc.py`, path in `start_session`'s `meta.script`). The script attaches with a note, chains actions, branches on results and reads whole frames as ints; its moves go through the same checks and log as tool moves. A lost token is replaced with `script_access`. Each session takes at most `STEP_RATE_MAX` steps per `STEP_RATE_WINDOW_MS` and `SESSION_STEPS_MAX` steps in all (`src/limits.js`). Contracts: [script-api.md](script-api.md).

## Offline bundle

- Build one archive on a machine with network (`node scripts/bundle.mjs export`): the pinned pip, every wheel, every game's source. Import it on a host without network (`node scripts/bundle.mjs import`), or point `CODE_ARC_BUNDLE` at an extracted copy.
- With a bundle, the toolkit installs with no download, and local play of the bundle's games needs no network. `list_games` tags each game `source: bundle | web`; web games are added when the web is reachable.
- Online play is unchanged; without network it fails with `NETWORK_ERROR`.
- For your own environments only: ARC publishes no license for the games. Details: [bundle.md](bundle.md).

## The `play-arc` skill

Shipped as a Claude Code plugin (`claude/`), loaded into every cc session through the manifest's `claudePlugin`. It tells an agent how to probe unknown games, keep token use low (diffs, `observe` only when lost), write reasoning the user can follow, when to script with notes, and react to each refusal code.
