---
name: play-arc
description: How to play ARC-AGI-3 games well with the Code ARC tools (code-arc__list_games, code-arc__start_session, code-arc__act, …). Use when asked to play an ARC game, an ARC-AGI-3 game, or to use the code-arc tools.
---

# Playing ARC-AGI-3 with Code ARC

- Goal: clear as many levels as you can. Learn the game only through the play tools (and `run_code` programs over them); never read game source, bundles or toolkit internals (`environment_files/`, `.arcbundle` files or bundle dirs, the `arc_agi`/`arcengine` packages).
- Read the first full frame once (from `start_session`). Then rely on `act`'s default diff; when you have lost spatial context, or need the layout, shapes or symmetry, call `observe` with `frame: "image"` and open the image path (`frame.path`; named in the text) with Read. Use the image for the gist and text frames for exact cells.
- Games come with no instructions. Probe each available action once early and note what changed. ACTION1–4 are often directional, ACTION5 interact, ACTION7 undo — none of it guaranteed.
- Put one or two sentences of your current hypothesis in `reasoning` on every act: the user watches it live.
- For repetitive or search-heavy play (sweeps, searching move sequences, replaying a route), script it with `run_code` (see the `code-conductor:scripting` skill): the program calls `cc.code_arc.*` and returns a digest, not frames.
  - Call `cc.code_arc.note({session_id, note})` first, saying what the program tries and why, and again whenever its plan changes: the user follows the run through these notes, and the program's steps show as scripted under the latest one.
  - Step with `cc.code_arc.act({session_id, action, reasoning, frame})`; json results carry `frame.rows` (`full`) or `frame.changed_rows` (`diff`).
  - Pace the acts under `STEP_RATE_MAX` per `STEP_RATE_WINDOW_MS`; `note` calls spend a slot too.
  - For a picture use `frame: "image"` and Read `frame.path` after the program returns.
  - `SCRIPT_UNAVAILABLE_REMOTE` → this session's project is on a remote System: play with the tools directly.
  ```js
  const session_id = 's-…'; // the id from start_session: a run_code program sees only `cc`
  await cc.code_arc.note({ session_id, note: 'Sweep each direction to see which cells move.' });
  const seen = [];
  for (const action of ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4']) {
    const r = await cc.code_arc.act({ session_id, action, reasoning: `probe ${action}`, frame: 'diff' });
    seen.push({ action, changed: r.frame.changed_cells, state: r.state });
  }
  return seen;
  ```
- `frame_count` above 1 means the action animated; `frame` is only the last frame. Pull the animation when the end state doesn't explain what the action did (something moved through cells, a projectile or path, an intermediate state flashed): `observe({session_id, animation: "all", animation_step: <the step from the act result>, frame: "none"})`, or `frame: "image"` for one contact sheet of numbered tiles. The first frame comes full, each later one as a diff against the frame before it, at most 16 per call; when `truncated`, call again with `animation_from: <next_from>`. Frames past the stored limit are listed as missing in the result. Don't put `animation: "all"` on every `act`; a `run_code` program can check `frame_count` and pull only the steps that animated.
- In `WIN` or `GAME_OVER`, only `reset` or `end_session` work. Sessions are one run unless started with `allow_reset: true` (only when the user allows retries): `reset` is refused (`RESET_DISABLED`), so `GAME_OVER` ends the run; `end_session`.
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
  - Lost a `session_id` (e.g. after compaction) → `list_sessions` (when it says more are not shown, call again with `offset`).
