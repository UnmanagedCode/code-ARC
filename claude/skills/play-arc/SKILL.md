---
name: play-arc
description: How to play ARC-AGI-3 games well with the Code ARC tools (code-arc__list_games, code-arc__start_session, code-arc__act, …). Use when asked to play an ARC game, an ARC-AGI-3 game, or to use the code-arc tools.
---

# Playing ARC-AGI-3 with Code ARC

- Read the first full frame once (from `start_session`). Then rely on `act`'s default diff; call `observe` only when you have lost spatial context.
- Games come with no instructions. Probe each available action once early and note what changed. ACTION1–4 are often directional, ACTION5 interact, ACTION7 undo — none of it guaranteed.
- Put one or two sentences of your current hypothesis in `reasoning` on every act: the user watches it live.
- `frame_count` above 1 means the action animated; you see only the last frame.
- In `WIN` or `GAME_OVER`, only `reset` or `end_session` work. `reset` restarts the current level (the whole game after a win).
- Always `end_session` when you are done: it closes the scorecard.
- Use `online: true` only when the user asks for an arcprize.org scorecard: every online step is a network round trip and counts against a rate limit.
- On a refusal (`result.ok: false`), read `code`:
  - `RATE_LIMITED` → wait `retry_after_ms` once; never loop.
  - `SCORECARD_CLOSED`, `SESSION_ENDED` → the session is over; start a new one only if asked to continue.
  - `TOOLKIT_NOT_READY` → the toolkit is installing; tell the user, retry a little later.
  - `TOOLKIT_UNAVAILABLE`, `DEPS_DIVERGED` → tell the user the `detail` and `fix`; don't retry in a loop.
  - `NOT_OWNER` → another agent's game; leave it alone.
  - `TOOLKIT_TIMEOUT`, `SESSION_STALLED` → `observe` before acting again.
  - Lost a `session_id` (e.g. after compaction) → `list_sessions`.
