"""Scripted play for Code ARC: a stdlib-only client for the script HTTP API.

    import sys; sys.path.insert(0, "<directory of meta.script.client>")
    from code_arc import Session, Refusal
    s = Session.attach(script["base_url"], script["token"], "Sweep ACTION6 along row 10: which cell toggles the door?")
    for x in range(64):
        obs = s.act("ACTION6", x=x, y=10)
        if obs.levels_completed: s.note("Row 10 solved it; replaying the route on level 2"); break

`script` is `meta.script` from start_session (or the result of the
script_access tool). Every refused call raises `Refusal` with the server's
code; nothing is retried. `TransportError` means the backend could not be
reached or answered garbage. Contracts: docs/protocol.md -> Script HTTP API.
"""

import json
import urllib.error
import urllib.request

__all__ = ["Session", "Observation", "Refusal", "TransportError"]

# The backend is always local: never route through an HTTP proxy from env.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Refusal(Exception):
    """The server refused the call: `code`, `reason`, `extra` (other fields)."""

    def __init__(self, code, reason, extra=None):
        super().__init__("{}: {}".format(code, reason))
        self.code = code
        self.reason = reason
        self.extra = dict(extra or {})
        self.retry_after_ms = self.extra.get("retry_after_ms")


class TransportError(Exception):
    """The backend was unreachable, answered non-JSON, or failed (5xx)."""


class Observation:
    """One script observation. `grid` is 64 rows of ints (palette indexes), or None."""

    def __init__(self, raw):
        self.raw = raw
        self.session_id = raw.get("session_id")
        self.step = raw.get("step")
        self.status = raw.get("status")
        self.end_reason = raw.get("end_reason")
        self.state = raw.get("state")
        self.levels_completed = raw.get("levels_completed")
        self.win_levels = raw.get("win_levels")
        self.available_actions = list(raw.get("available_actions") or [])
        self.frame_count = raw.get("frame_count")
        self.full_reset = raw.get("full_reset")
        self.online = raw.get("online")
        frame = raw.get("frame")
        self.grid = None if frame is None else [[int(c, 16) for c in row] for row in frame]

    def __repr__(self):
        return "Observation(step={!r}, state={!r}, levels={!r}/{!r})".format(self.step, self.state, self.levels_completed, self.win_levels)


class Session:
    """A script's handle on one game session. Create it with `Session.attach`."""

    def __init__(self, base_url, token, timeout=60):
        self.base_url = base_url if base_url.endswith("/") else base_url + "/"
        self._token = token
        self.timeout = timeout
        self.run = None
        self.session_id = None
        self.last = None

    @classmethod
    def attach(cls, base_url, token, note, timeout=60):
        """Attach with a note saying what the script tries and why; opens a run."""
        s = cls(base_url, token, timeout)
        raw = s._post("attach", {"note": note})
        s.run = raw.get("run")
        s._observed(raw)
        return s

    def act(self, action, x=None, y=None, reasoning=None):
        body = {"run": self.run, "action": action}
        if x is not None:
            body["x"] = x
        if y is not None:
            body["y"] = y
        if reasoning is not None:
            body["reasoning"] = reasoning
        return self._observed(self._post("act", body))

    def reset(self, reasoning=None):
        body = {"run": self.run}
        if reasoning is not None:
            body["reasoning"] = reasoning
        return self._observed(self._post("reset", body))

    def observe(self):
        return self._observed(self._post("observe", {}))

    def note(self, text):
        """The plan changed: opens a new run under `text`."""
        raw = self._post("note", {"run": self.run, "note": text})
        self.run = raw.get("run")
        return self.run

    def _observed(self, raw):
        obs = Observation(raw)
        self.last = obs
        self.session_id = obs.session_id
        return obs

    def _post(self, op, body):
        url = self.base_url + op
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + self._token},
        )
        try:
            with _OPENER.open(req, timeout=self.timeout) as resp:
                status, text = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            raise TransportError(
                "cannot reach {}: {}. Scripted play needs Bash on cc's host; remote-System workers can't reach it.".format(self.base_url, e)
            ) from None
        try:
            data = json.loads(text.decode("utf-8"))
        except ValueError:
            raise TransportError("{}: HTTP {} with a non-JSON body".format(url, status)) from None
        if status >= 500:
            raise TransportError("{}: HTTP {}: {}".format(url, status, data))
        if isinstance(data, dict) and data.get("ok") is False:
            extra = {k: v for k, v in data.items() if k not in ("ok", "code", "reason")}
            raise Refusal(data.get("code"), data.get("reason"), extra)
        if status >= 400:
            if isinstance(data, dict) and "code" in data:
                raise Refusal(data["code"], data.get("error", ""), {"status": status})
            raise TransportError("{}: HTTP {}: {}".format(url, status, data))
        if not isinstance(data, dict):
            raise TransportError("{}: unexpected body {!r}".format(url, data))
        return data
