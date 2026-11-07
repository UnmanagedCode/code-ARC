"""Scripted play for Code ARC: a stdlib-only client for the script HTTP API.

    import sys; sys.path.insert(0, "<directory of script['client']>")
    from code_arc import Session, Refusal
    s = Session.attach(script["base_url"], script["token"], "Sweep ACTION6 along row 10: which cell toggles the door?")
    for x in range(64):
        obs = s.act("ACTION6", x=x, y=10)
        if obs.levels_completed: s.note("Row 10 solved it; replaying the route on level 2"); break
    obs.save_png("/tmp/board.png")

`script` is the `script` block from start_session (or from the
script_access tool's result). Every refused call raises `Refusal` with the server's
code; nothing is retried. `TransportError` means the backend could not be
reached or answered garbage. Contracts: docs/script-api.md.
"""

import json
import os
import struct
import tempfile
import urllib.error
import urllib.request
import zlib

__all__ = ["Session", "Observation", "Refusal", "TransportError"]

# The backend is always local: never route through an HTTP proxy from env.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# Largest response body read; an observation is a few KB.
MAX_RESPONSE_BYTES = 1 << 20
# The board image spec, shared with the backend; it must stay next to this file.
_IMAGE_SPEC_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board_image.json")
_image_spec = None


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
        self.allow_reset = raw.get("allow_reset", True)
        frame = raw.get("frame")
        self.grid = None if frame is None else [[int(c, 16) for c in row] for row in frame]

    def save_png(self, path, scale=None, grid=None):
        """Writes `.grid` as a board image PNG at `path`; returns its absolute path.

        `scale` is pixels per cell, `grid` adds lines and labelled ticks; None
        means the spec default (board_image.json). Raises ValueError with no
        frame or an option out of bounds. Pixel rules: docs/protocol.md → Board image.
        """
        spec = _load_image_spec()
        if self.grid is None:
            raise ValueError("this observation has no frame")
        lo, hi = spec["scale"]["min"], spec["scale"]["max"]
        if scale is None:
            scale = spec["scale"]["default"]
        if isinstance(scale, bool) or not isinstance(scale, int) or not lo <= scale <= hi:
            raise ValueError("scale must be an integer in {}-{}".format(lo, hi))
        if grid is None:
            grid = spec["grid"]["default"]
        if not isinstance(grid, bool):
            raise ValueError("grid must be a bool")
        width, height, rows = _render_board(spec, self.grid, scale, grid)
        data = _encode_png(width, height, rows)
        path = os.path.abspath(path)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return path

    def __repr__(self):
        return "Observation(step={!r}, state={!r}, levels={!r}/{!r})".format(self.step, self.state, self.levels_completed, self.win_levels)


def _rgb(hex_colour):
    return bytes(int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))


def _load_image_spec():
    global _image_spec
    if _image_spec is None:
        try:
            with open(_IMAGE_SPEC_PATH, encoding="utf-8") as f:
                _image_spec = json.load(f)
        except FileNotFoundError:
            raise FileNotFoundError("board image spec missing: {} (keep board_image.json next to code_arc.py)".format(_IMAGE_SPEC_PATH)) from None
    return _image_spec


def _render_board(spec, cells, s, grid_on):
    """(width, height, rows): rows are bytearrays of RGB pixels, top to bottom."""
    side = 64
    h = len(cells)
    w = len(cells[0]) if h else 0
    if not 1 <= h <= side or not 1 <= w <= side:
        raise ValueError("a board image needs 1-{} rows and columns".format(side))
    for y, row in enumerate(cells):
        if len(row) != w:
            raise ValueError("ragged rows: row {} is not {} wide".format(y, w))
        if not all(isinstance(v, int) and 0 <= v <= 15 for v in row):
            raise ValueError("row {} has a value outside 0-15".format(y))
    g = spec["grid"]
    palette = [_rgb(c) for c in spec["palette"]]
    m = g["margin"] if grid_on else 0
    width, height = m + w * s, m + h * s
    margin_px = _rgb(g["margin_rgb"])
    rows = [bytearray(margin_px * width) for _ in range(m)]
    for row in cells:
        line = bytearray(margin_px * m)
        for v in row:
            line += palette[v] * s
        rows.extend(bytearray(line) for _ in range(s))
    if not grid_on:
        return width, height, rows

    def put(x, y, px):
        if 0 <= x < width and 0 <= y < height:
            rows[y][x * 3:x * 3 + 3] = px

    contrast = [_rgb(c) for c in g["contrast"]]
    every, dash = g["every"], g["dash"]
    for c in range(every, w, every):
        for along in range(0, h * s):
            if (along // dash) % 2 == 0:
                put(m + c * s, m + along, contrast[cells[along // s][c]])
    for r in range(every, h, every):
        for along in range(0, w * s):
            if (along // dash) % 2 == 0:
                put(m + along, m + r * s, contrast[cells[r][along // s]])

    label_px = _rgb(g["label_rgb"])
    fs, off = g["font_scale"], g["label_offset"]

    def label(n, ox, oy):
        for i, d in enumerate(str(n)):
            glyph = g["glyphs"][d]
            dx = ox + i * (len(glyph[0]) + 1) * fs
            for gy, glyph_row in enumerate(glyph):
                for gx, ch in enumerate(glyph_row):
                    if ch != "#":
                        continue
                    for a in range(fs):
                        for b in range(fs):
                            put(dx + gx * fs + a, oy + gy * fs + b, label_px)

    for c in range(0, w, every):
        for y in range(m - g["tick_len"], m):
            put(m + c * s, y, label_px)
        label(c, m + c * s + off, off)
    for r in range(0, h, every):
        for x in range(m - g["tick_len"], m):
            put(x, m + r * s, label_px)
        label(r, off, m + r * s + off)
    return width, height, rows


def _png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def _encode_png(width, height, rows):
    """8-bit RGB, not interlaced, filter 0 on every row, one IDAT."""
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", zlib.compress(raw)) + _png_chunk(b"IEND", b"")


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
                status, text = resp.status, resp.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read(MAX_RESPONSE_BYTES + 1)
        except (urllib.error.URLError, OSError) as e:
            raise TransportError(
                "cannot reach {}: {}. Scripted play needs Bash on cc's host; remote-System workers can't reach it.".format(self.base_url, e)
            ) from None
        if len(text) > MAX_RESPONSE_BYTES:
            raise TransportError("{}: HTTP {} with a body over {} bytes".format(url, status, MAX_RESPONSE_BYTES))
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
