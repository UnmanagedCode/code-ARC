# Scripted play

Scripted play is cc's `run_code`: an agent writes JavaScript that calls the plugin's tools as `await cc.code_arc.<tool>({...})` and returns a digest. Code ARC has no script API of its own. Refusal codes, the step and note shapes and SSE events are in [protocol.md](protocol.md); bounds are named by their constant in `src/limits.js`.

## What counts as scripted

A step is recorded `source:"script"` when its call's `format` is `json`, else `source:"tool"` (`handle` in `src/mcp.js` sets `caller.source`; `tagOf` in `src/sessions.js` tags every step, `START` and late replies included).

- A `run_code` program's `cc.code_arc.*` calls go through cc's REST alias, which always sends `format:"json"`. cc starts every agent session with `?format=text` on its MCP URL. So for cc's own agents, json means a program: `run_code`, or a hand-written REST alias call, which is scripted play too.
- cc passes a plugin only `{tool, arguments, caller, format}`; its own "this came from `run_code`" flag is not forwarded, so `format` is the signal.
- **Known mislabel:** an external MCP application that connects to `/mcp` without `?format=text` gets json, so its steps show as `script`. The exact fix would be cc forwarding that flag to plugins.
- The format gates nothing: a json step with no note yet is allowed.

## Runs and notes

- The `note` tool (`session_id`, `note`: 1–`NOTE_MAX_CHARS`, not blank after trimming) opens run `k+1` and returns `{session_id, run}`. Both formats may call it; only json steps record the run.
- A json step records the session's latest run. With no note yet it has no `run`: the viewer shows the script badge and no run header.
- Runs never expire; a text (tool) step in between doesn't end one. The counter is per session, in memory (the runtime entry), and goes when the session ends. Notes are stored in `sessions/<sid>/notes.jsonl` as `{run, ts, text, from_step}` and announced as the SSE `note` event.
- Gating: `SESSION_UNKNOWN` → `SESSION_ENDED` → `NOT_OWNER` → `INVALID_ARGUMENT` (blank) → `TOO_MANY_NOTES` (`NOTES_MAX`) → `STEP_RATE_LIMITED`. A refused note stores nothing and spends no rate slot.
- Every `note`, and every `act`/`reset` in either format, spends one slot of the per-session step rate (`STEP_RATE_MAX` per `STEP_RATE_WINDOW_MS`). A refusal is never delayed or retried by the backend.
- `SESSION_STEPS_MAX` bounds a session's steps.

## Calling from a program

- Namespace `cc.code_arc`; tool names and arguments are the MCP tools' ([protocol.md](protocol.md) → MCP tools). Results are the json `structured` data: `frame.rows` (`frame:"full"`) or `frame.changed_rows` (`frame:"diff"`), hex row strings.
- A refusal throws cc's `ConductorError` with `.code`, `.reason`, `.status` (200), `.details` (the refusal's extras, e.g. `details.retry_after_ms`).
- `frame:"image"` writes a PNG and returns `frame.path`; the program can't view it, so return the path and Read it after the program ends.
- Pace calls under the step rate; on `STEP_RATE_LIMITED` wait `details.retry_after_ms` once, never loop.

## Limits

- `run_code` refuses `SCRIPT_UNAVAILABLE_REMOTE` for a session whose project lives on a remote System (its program always runs on cc's own machine). Those agents play with the tools directly.
