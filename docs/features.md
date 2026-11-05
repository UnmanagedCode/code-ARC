# Features

## The Code ARC view

- **Session list** (newest first; the newest page loads at once, **Load older sessions** fetches more): game title, `local`/`online` badge, status (`Live`, `Stalled`, or how it ended), step and state, and who is playing — the cc session id (shortened) and project, or "unknown caller". Inside cc, **Open session** jumps to the playing agent's session (when it is live).
- **Header strip:** game, state, levels as `completed/total`, mode, and for online sessions a **Scorecard on arcprize.org** link. Badges for a stalled session and for "Scorecard auto-closed by arcprize.org (15 min idle)".
- **Frame:** the 64×64 grid in the ARC palette, scaled crisply. Hover a cell to see `x,y = value`.
- **Replay:** a scrubber with previous/next buttons and **Follow live** (on by default; it turns off when you scrub back). Clicking a row in the **Action log** jumps to that step.
- **Reasoning:** the selected step's reasoning, exactly as the agent wrote it.
- **Live:** new steps and session changes arrive as they happen; a reconnect catches up.
- **Deep links:** the URL carries `?session=<id>&step=<n>`; pasting it reopens that step.
- **Toolkit banner:** shown while the toolkit is installing, or with the error and the fix when installing failed or the venv diverged.
- Follows cc's light/dark theme (or the OS theme standalone) and cc's session width.

## Settings

- **ARC API key:** paste, **Save**, **Clear**. Shown only masked: the last four characters, or nothing for keys shorter than `TAIL_MIN_LENGTH` (`src/keyStore.js`). Empty means the toolkit's anonymous key.
- Changing the key is refused while any game session is live (end them first) or another change is still saving; the panel shows the server's reason.

## Agent tools

`list_games`, `start_session`, `act`, `reset`, `observe`, `end_session`, `list_sessions` — contracts in [protocol.md](protocol.md).

- Frames come as text (one hex digit per cell with coordinate headers); `act` sends only the changed rows by default, which keeps a typical move to a few lines.
- `online:true` on `start_session` plays against arcprize.org with a real scorecard (link in the result and the viewer). Rate limits and idle closes are reported as refusals, never retried silently.
- Only the agent session that started a game can act on or end it; anyone can observe.

## The `play-arc` skill

Shipped as a Claude Code plugin (`claude/`), loaded into every cc session through the manifest's `claudePlugin`. It tells an agent how to probe unknown games, keep token use low (diffs, `observe` only when lost), write reasoning the user can follow, and react to each refusal code.
