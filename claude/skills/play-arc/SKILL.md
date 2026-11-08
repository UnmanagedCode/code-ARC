---
name: play-arc
description: How to play ARC-AGI-3 games well with the Code ARC tools (code-arc__list_games, code-arc__start_session, code-arc__act, …). Use when asked to play an ARC game, an ARC-AGI-3 game, or to use the code-arc tools.
---

# Playing ARC-AGI-3 with Code ARC

- Goal: clear as many levels as you can. Learn the game only through the play tools (and scripts over them); never read game source, bundles or toolkit internals (`environment_files/`, `.arcbundle` files or bundle dirs, the `arc_agi`/`arcengine` packages).
- Read the first full frame once (from `start_session`). Then rely on `act`'s default diff; when you have lost spatial context, or need the layout, shapes or symmetry, call `observe` with `frame: "image"` and open the image path (`frame.path`; named in the text) with Read. Use the image for the gist and text frames for exact cells.
- Games come with no instructions. Probe each available action once early and note what changed. ACTION1–4 are often directional, ACTION5 interact, ACTION7 undo — none of it guaranteed.
- Put one or two sentences of your current hypothesis in `reasoning` on every act: the user watches it live.
- For repetitive or search-heavy play (sweeps, searching move sequences, replaying a route), write a Python script with the client at `script.client` from `start_session`. Attach with a note saying what the script tries and why, and call `.note()` whenever its plan changes: the user follows the run through these notes.
- `frame_count` above 1 means the action animated; you see only the last frame.
- In `WIN` or `GAME_OVER`, only `reset` or `end_session` work. `reset` restarts the current level (the whole game after a win). A session started with `allow_reset: false` (use it only when the user asks for one run) refuses every reset (`RESET_DISABLED`): `GAME_OVER` ends the run, so `end_session`.
- Always `end_session` when you are done: it closes the scorecard.
- Use `online: true` only when the user asks for an arcprize.org scorecard: every online step is a network round trip and counts against a rate limit.
- On a refusal (an error with a `code`), read `code`; the message says why, and extra fields are in `details`:
  - `RATE_LIMITED`, `STEP_RATE_LIMITED` → wait `details.retry_after_ms` once; never loop.
  - `ACTION_UNAVAILABLE` → pick from `details.available_actions`.
  - `SCORECARD_CLOSED`, `SESSION_ENDED` → the session is over; start a new one only if asked to continue.
  - `TOOLKIT_NOT_READY` → temporary (toolkit installing, or the API key being changed): relay the message to the user, retry a little later.
  - `TOOLKIT_UNAVAILABLE`, `DEPS_DIVERGED` → tell the user `details.detail` and `details.fix`; don't retry in a loop.
  - `NOT_OWNER` → another agent's game; leave it alone.
  - `TOOLKIT_TIMEOUT`, `SESSION_STALLED` → `observe` before acting again.
  - Lost a `session_id` (e.g. after compaction) → `list_sessions` (when it says more are not shown, call again with `offset`); lost the script token → `script_access` (replaces the old one).
