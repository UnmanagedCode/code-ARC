"""Toolkit adapter: one Arcade per mode, the live environments, and the ops the
Node backend calls. Imports arc_agi/arcengine lazily (they pull numpy,
matplotlib and flask) and never imports numpy itself.

Arcades, by mode key:
  normal  NORMAL mode over the toolkit's default dir (local play, downloads)
  online  ONLINE mode (play on arcprize.org)
  bundle  OFFLINE mode over a verified offline bundle's games dir, only when
          configure() named one: no network, never writes into the dir
"""

import json
import logging
import os
import re
import sys
import threading
from typing import Any, Optional

ACTIONS = ("ACTION1", "ACTION2", "ACTION3", "ACTION4", "ACTION5", "ACTION6", "ACTION7")
GAME_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
HEX = "0123456789abcdef"
FRAME_MAX = 64
# Frames kept per step: the first ANIMATION_FRAMES_MAX - 1 and the last. Mirrors
# src/limits.js (tests/manifest.test.mjs pins them equal).
ANIMATION_FRAMES_MAX = 64
TITLE_MAX = 200
TAGS_MAX = 20
TAG_MAX = 40
DETAIL_MAX = 300
# Bound on log text the classifier scans (it is untrusted, remote-written).
SCAN_MAX = 4000
ANON_KEY_RE = re.compile(r"(Got anonymous API key: )\S+")
# With a bundle, how long list_games waits for the web's game list before
# answering with the bundle's games alone (the web list keeps loading).
WEB_LIST_WAIT_S = 5.0
MODES = ("bundle", "normal", "online")


class Refusal(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class Redactor:
    """Replaces every known secret, and the toolkit's anonymous-key log line,
    with [redacted]. Secrets are added as they become known."""

    def __init__(self) -> None:
        self._secrets: set = set()
        self._lock = threading.Lock()

    def add(self, secret: Optional[str]) -> None:
        if secret and len(secret) >= 4:
            with self._lock:
                self._secrets.add(secret)

    def __call__(self, text: str) -> str:
        with self._lock:
            secrets = sorted(self._secrets, key=len, reverse=True)
        for s in secrets:
            text = text.replace(s, "[redacted]")
        return ANON_KEY_RE.sub(r"\1[redacted]", text)


class RedactFilter(logging.Filter):
    def __init__(self, redactor: Redactor) -> None:
        super().__init__()
        self.redactor = redactor

    def filter(self, record: logging.LogRecord) -> bool:
        msg = self.redactor(record.getMessage())
        record.msg = msg
        record.args = None
        if record.exc_info:
            # Render the traceback now, redacted, and drop the live exception
            # so no handler formats the unredacted original.
            text = logging.Formatter().formatException(record.exc_info)
            record.exc_text = self.redactor(text)
            record.code_arc_exc = record.exc_info[1]
            record.exc_info = None
        return True


class CaptureHandler(logging.Handler):
    """Collects the records emitted on the current thread while capturing, so
    a failed toolkit call can be classified from what the toolkit logged."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self._local = threading.local()

    def start(self) -> list:
        records: list = []
        self._local.records = records
        return records

    def stop(self) -> None:
        self._local.records = None

    def emit(self, record: logging.LogRecord) -> None:
        records = getattr(self._local, "records", None)
        if records is not None:
            records.append(record)


def reasoning_bytes(reasoning: dict, online: bool) -> int:
    """Size of `reasoning` as the toolkit measures it (arcengine.ActionInput:
    compact json.dumps with ensure_ascii, utf-8). Online, the remote wrapper
    sends json.dumps(reasoning) as a string and the server validates that
    string, so it is measured double-encoded."""
    if online:
        return len(json.dumps(json.dumps(reasoning), separators=(",", ":")).encode("utf-8"))
    return len(json.dumps(reasoning, separators=(",", ":")).encode("utf-8"))


def _exc_name_chain(e: BaseException) -> set:
    return {c.__name__ for c in type(e).__mro__}


def _exceptions(exc: Optional[BaseException], records: list) -> list:
    out = [exc] if exc is not None else []
    for r in records:
        e = getattr(r, "code_arc_exc", None)
        if e is None and r.exc_info:
            e = r.exc_info[1]
        if e is not None:
            out.append(e)
    return out


AUTH_HINT = (
    "arcprize.org rejected the API key (HTTP {status}): check it in Code ARC Settings, "
    "or clear it to use the toolkit's anonymous key. "
)


def auth_status(records: list, exc: Optional[BaseException] = None) -> Optional[int]:
    """401/403 when arcprize.org refused the key, from an exception's HTTP
    status or the toolkit's `(status=401)` / `401 Client Error` log text."""
    for e in _exceptions(exc, records):
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status in (401, 403):
            return status
    for r in records:
        m = re.search(r"\(status=(40[13])\)|\b(40[13]) Client Error", r.getMessage()[:SCAN_MAX])
        if m:
            return int(m.group(1) or m.group(2))
    return None


def classify_failure(op: str, records: list, exc: Optional[BaseException] = None) -> str:
    """Map a failed toolkit call to a refusal code, from the exception it raised
    or the records it logged. Patterns match the live service (see the wiki's
    failure-classification page). A refused key is TOOLKIT_ERROR; its detail
    names the key (see _detail)."""
    if auth_status(records, exc) is not None:
        return "TOOLKIT_ERROR"
    for e in _exceptions(exc, records):
        resp = getattr(e, "response", None)
        status = getattr(resp, "status_code", None)
        body = str(getattr(resp, "text", "") or "")[:SCAN_MAX]
        names = _exc_name_chain(e)
        if status == 429:
            return "RATE_LIMITED"
        if names & {"Timeout", "ConnectTimeout", "ReadTimeout", "ConnectionError", "TimeoutError"}:
            return "NETWORK_ERROR"
        if op in ("step", "reset", "close") and status in (400, 404, 410) and re.search(r"not found|closed", body, re.I):
            return "SCORECARD_CLOSED"
        if op == "open" and status == 404:
            return "GAME_UNKNOWN"
    text = " | ".join(r.getMessage()[:SCAN_MAX] for r in records)
    if exc is not None:
        text += " | " + str(exc)[:SCAN_MAX]
    if re.search(r"status=429|429 Client Error|Too Many Requests", text):
        return "RATE_LIMITED"
    if re.search(r"timed out|Max retries exceeded|Connection (refused|aborted|reset)|NameResolution|Failed to resolve", text, re.I):
        return "NETWORK_ERROR"
    if op == "open" and re.search(r"\(status=404\)|not found in scanned environments", text):
        return "GAME_UNKNOWN"
    if op in ("step", "reset", "close") and re.search(r"(scorecard|game) \S+ not found", text):
        return "SCORECARD_CLOSED"
    return "TOOLKIT_ERROR"


def _detail(records: list, exc: Optional[BaseException], fallback: str) -> str:
    parts = [r.getMessage() for r in records if r.levelno >= logging.WARNING]
    if exc is not None:
        parts.append(f"{type(exc).__name__}: {exc}")
    status = auth_status(records, exc)
    hint = AUTH_HINT.format(status=status) if status is not None else ""
    return (hint + (" | ".join(parts) or fallback))[:DETAIL_MAX]


def _cap(s: Any, n: int) -> str:
    return str(s if s is not None else "")[:n]


def _hex_rows(frame: Any) -> list:
    """One toolkit frame (numpy array or nested lists) as hex rows; raises
    Refusal when it is not a rectangular grid of palette values."""
    grid = frame.tolist() if hasattr(frame, "tolist") else frame
    if not isinstance(grid, list) or not (1 <= len(grid) <= FRAME_MAX):
        raise Refusal("TOOLKIT_ERROR", "frame has an unexpected shape")
    width = len(grid[0]) if isinstance(grid[0], list) else 0
    if not (1 <= width <= FRAME_MAX):
        raise Refusal("TOOLKIT_ERROR", "frame has an unexpected shape")
    rows = []
    for row in grid:
        if not isinstance(row, list) or len(row) != width:
            raise Refusal("TOOLKIT_ERROR", "frame is not rectangular")
        for v in row:
            if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 15:
                raise Refusal("TOOLKIT_ERROR", "frame value outside the palette")
        rows.append("".join(HEX[v] for v in row))
    return rows


def _leading_frames(frames: list) -> list:
    """The animation's frames before the last, oldest first, at most
    ANIMATION_FRAMES_MAX - 1 (the first ones). An invalid leading frame drops
    the whole list with a warning: the action is already applied, so refusing
    here would desync the recorded history."""
    lead = frames[:-1] if len(frames) <= ANIMATION_FRAMES_MAX else frames[: ANIMATION_FRAMES_MAX - 1]
    try:
        return [_hex_rows(f) for f in lead]
    except Refusal as e:
        sys.stderr.write(f"[code-arc] dropping the animation frames of this step: {e.detail}\n")
        sys.stderr.flush()
        return []


def normalize_obs(obs: Any) -> dict:
    frames = list(getattr(obs, "frame", None) or [])
    rows = _hex_rows(frames[-1]) if frames else None
    anim = _leading_frames(frames) if len(frames) > 1 else []
    state = getattr(obs, "state", None)
    state = getattr(state, "value", state)
    return {
        "state": str(state),
        "levels_completed": int(getattr(obs, "levels_completed", 0) or 0),
        "win_levels": int(getattr(obs, "win_levels", 0) or 0),
        "available_actions": sorted({int(a) for a in (getattr(obs, "available_actions", None) or []) if 0 <= int(a) <= 7}),
        "full_reset": bool(getattr(obs, "full_reset", False)),
        "frame_count": len(frames),
        "frame": rows,
        "anim": anim,
    }


def summarize_scorecard(sc: Any) -> Optional[dict]:
    if sc is None:
        return None
    d = sc.model_dump(exclude_none=True) if hasattr(sc, "model_dump") else dict(sc)
    envs = []
    for e in (d.get("environments") or [])[:20]:
        envs.append({k: e.get(k) for k in ("id", "score", "levels_completed", "actions", "resets", "completed", "level_count") if k in e})
    out = {k: d.get(k) for k in ("card_id", "score", "total_levels_completed", "total_levels", "total_actions") if k in d}
    out["environments"] = envs
    return json.loads(json.dumps(out, default=str))


def _game_entry(e: Any, source: str) -> Optional[dict]:
    gid = str(getattr(e, "game_id", "") or "")
    if not GAME_ID_RE.match(gid):
        return None
    tags = [_cap(t, TAG_MAX) for t in (getattr(e, "tags", None) or [])[:TAGS_MAX]]
    entry = {
        "game_id": gid,
        "title": _cap(getattr(e, "title", None) or gid, TITLE_MAX),
        "tags": tags,
        "downloaded": bool(getattr(e, "local_dir", None)),
        "source": source,
    }
    return entry


class _Session:
    def __init__(self, env: Any, arcade: Any, card: str, online: bool) -> None:
        self.env = env
        self.arcade = arcade
        self.card = card
        self.online = online
        self.lock = threading.Lock()


class Engine:
    def __init__(self, logger: logging.Logger, capture: CaptureHandler, redactor: Redactor) -> None:
        self.log = logger
        self.capture = capture
        self.redactor = redactor
        self.api_key: Optional[str] = None
        self.games_dir: Optional[str] = None
        self.configured = False
        self.web_list_wait_s = WEB_LIST_WAIT_S
        # _arcade_lock guards the dicts only; an arcade is built under its
        # mode's build lock, so a slow NORMAL build never blocks the others.
        self._arcades: dict = {}
        self._arcade_lock = threading.Lock()
        self._build_locks = {m: threading.Lock() for m in MODES}
        # Bumped by configure(); an arcade built for an older configuration is dropped.
        self._generation = 0
        self._web_thread: Optional[threading.Thread] = None
        self._web_error: Optional[Refusal] = None
        self._sessions: dict = {}
        self._sessions_lock = threading.Lock()

    # -- toolkit access ---------------------------------------------------
    @staticmethod
    def _toolkit() -> tuple:
        import arc_agi  # noqa: PLC0415 - lazy: heavy import
        import arcengine  # noqa: PLC0415

        return arc_agi, arcengine

    def _arcade(self, mode: str) -> Any:
        arc_agi, _ = self._toolkit()
        with self._arcade_lock:
            arcade = self._arcades.get(mode)
            generation = self._generation
        if arcade is not None:
            return arcade
        with self._build_locks[mode]:
            with self._arcade_lock:
                arcade = self._arcades.get(mode)
            if arcade is not None:
                return arcade
            if mode == "bundle":
                arcade = arc_agi.Arcade(arc_api_key="", operation_mode=arc_agi.OperationMode.OFFLINE,
                                        environments_dir=self.games_dir, logger=self.log)
            else:
                op_mode = arc_agi.OperationMode.ONLINE if mode == "online" else arc_agi.OperationMode.NORMAL
                arcade = arc_agi.Arcade(arc_api_key=self.api_key or "", operation_mode=op_mode, logger=self.log)
            self.redactor.add(getattr(arcade, "arc_api_key", None))
            with self._arcade_lock:
                if self._generation == generation:
                    self._arcades[mode] = arcade
            return arcade

    def _call(self, op: str, fn: Any) -> Any:
        records = self.capture.start()
        try:
            return fn(), records
        except Refusal:
            raise
        except Exception as e:  # noqa: BLE001 - every toolkit failure is classified
            raise Refusal(classify_failure(op, records, e), self.redactor(_detail(records, e, "toolkit call failed")))
        finally:
            self.capture.stop()

    def _fail(self, op: str, records: list, fallback: str) -> Refusal:
        return Refusal(classify_failure(op, records), self.redactor(_detail(records, None, fallback)))

    def _session(self, session_id: str) -> _Session:
        with self._sessions_lock:
            s = self._sessions.get(session_id)
        if s is None:
            raise Refusal("SESSION_UNKNOWN", "no such session in the toolkit")
        return s

    # -- ops ----------------------------------------------------------------
    def configure(self, api_key: Optional[str], games_dir: Optional[str] = None) -> dict:
        if games_dir is not None and not (isinstance(games_dir, str) and os.path.isabs(games_dir) and os.path.isdir(games_dir)):
            raise Refusal("INVALID_ARGUMENT", "games_dir must be an absolute path to an existing directory")
        with self._sessions_lock:
            if self._sessions:
                raise Refusal("SESSIONS_ACTIVE", "cannot reconfigure with live sessions")
        with self._arcade_lock:
            self._arcades.clear()
            self._generation += 1
            self._web_thread = None
            self._web_error = None
        self.api_key = api_key or None
        self.games_dir = games_dir
        self.redactor.add(self.api_key)
        self.configured = True
        return {}

    def _normal_envs(self) -> list:
        """The NORMAL arcade's game list; a failed fetch is a refusal."""

        def run() -> list:
            with self._arcade_lock:
                cached = self._arcades.get("normal")
                # The toolkit fetches the list once, at construction: an
                # arcade holding an empty list is rebuilt (once) rather than reused.
                if cached is not None and not cached.get_environments():
                    del self._arcades["normal"]
            return self._arcade("normal").get_environments()

        envs, records = self._call("list_games", run)
        if not envs and any(r.levelno >= logging.WARNING for r in records):
            # Arcade() catches a failed /api/games fetch and only logs it.
            with self._arcade_lock:
                self._arcades.pop("normal", None)
            raise self._fail("list_games", records, "the toolkit could not list games")
        return envs

    def _build_web(self) -> None:
        try:
            self._normal_envs()
        except Refusal as r:
            self._web_error = r
            self.log.warning(f"web game list failed ({r.code})")
        except Exception as e:  # noqa: BLE001 - a background thread must not die silently
            self._web_error = Refusal("TOOLKIT_ERROR", self.redactor(f"{type(e).__name__}: {e}")[:DETAIL_MAX])

    def _web_envs(self) -> tuple:
        """With a bundle: the web's games if they load within web_list_wait_s,
        else ([], {code, detail}). The build keeps running in the background."""
        with self._arcade_lock:
            cached = self._arcades.get("normal")
        envs = cached.get_environments() if cached is not None else []
        if envs:
            return envs, None
        with self._arcade_lock:
            t = self._web_thread
            if t is None or not t.is_alive():
                self._web_error = None
                t = threading.Thread(target=self._build_web, name="code-arc-web-list", daemon=True)
                self._web_thread = t
                t.start()
        t.join(self.web_list_wait_s)
        with self._arcade_lock:
            cached = self._arcades.get("normal")
            err = None if t.is_alive() else self._web_error
        envs = cached.get_environments() if cached is not None else []
        if envs:
            return envs, None
        if err is not None:
            gap = {"code": err.code, "detail": self.redactor(err.detail)[:DETAIL_MAX]}
        else:
            gap = {"code": "WEB_LIST_LOADING", "detail": f"the web game list did not load within {self.web_list_wait_s} s"}
        self.log.warning(f"web game list unavailable ({err.code if err else 'still loading'}); listing the bundle's games")
        return [], gap

    def _bundle_ids(self) -> set:
        return {str(getattr(e, "game_id", "") or "") for e in self._arcade("bundle").get_environments()}

    def list_games(self) -> dict:
        if not self.games_dir:
            return {"games": [g for g in (_game_entry(e, "web") for e in self._normal_envs()) if g]}
        bundled, records = self._call("list_games", lambda: self._arcade("bundle").get_environments())
        if not bundled and any(r.levelno >= logging.WARNING for r in records):
            raise self._fail("list_games", records, "the toolkit could not list the bundle's games")
        games = [g for g in (_game_entry(e, "bundle") for e in bundled) if g]
        ids = {g["game_id"] for g in games}
        web, gap = self._web_envs()
        games += [g for g in (_game_entry(e, "web") for e in web) if g and g["game_id"] not in ids]
        out: dict = {"games": games}
        if gap is not None:
            # Games outside the bundle can't be listed: the backend answers a
            # start of an unlisted id with this instead of a bare GAME_UNKNOWN.
            out["web_unavailable"] = gap
        return out

    def open(self, session_id: str, game_id: str, online: bool) -> dict:
        if not GAME_ID_RE.match(game_id or ""):
            raise Refusal("INVALID_ARGUMENT", "game_id is malformed")
        with self._sessions_lock:
            if session_id in self._sessions:
                raise Refusal("INVALID_ARGUMENT", "session id already open")

        def run() -> tuple:
            if online:
                mode = "online"
            elif self.games_dir and (game_id in (ids := self._bundle_ids()) or game_id in {i.split("-", 1)[0] for i in ids}):
                mode = "bundle"
            else:
                mode = "normal"
            arcade = self._arcade(mode)
            card = arcade.create_scorecard(tags=["code-arc"])
            env = arcade.make(game_id, scorecard_id=card)
            return arcade, card, env

        (arcade, card, env), records = self._call("open", run)
        obs = getattr(env, "observation_space", None) if env is not None else None
        if obs is None:
            if online:
                try:
                    arcade.close_scorecard(card)
                except Exception:  # noqa: BLE001 - best effort; the open already failed
                    pass
            raise self._fail("open", records, f"could not start game {game_id}")
        with self._sessions_lock:
            self._sessions[session_id] = _Session(env, arcade, str(card), bool(online))
        info = getattr(env, "environment_info", None)
        return {
            "scorecard_id": str(card),
            "game_id": str(getattr(info, "game_id", None) or game_id)[:64],
            "title": _cap(getattr(info, "title", None) or game_id, TITLE_MAX),
            "obs": normalize_obs(obs),
        }

    def _locked(self, session_id: str) -> _Session:
        s = self._session(session_id)
        if not s.lock.acquire(blocking=False):
            raise Refusal("SESSION_BUSY", "another call on this session is in flight")
        return s

    def step(self, session_id: str, action: str, x: Optional[int] = None, y: Optional[int] = None, reasoning: Optional[str] = None) -> dict:
        if action not in ACTIONS:
            raise Refusal("INVALID_ARGUMENT", "unknown action")
        s = self._locked(session_id)
        try:
            _, arcengine = self._toolkit()
            ga = arcengine.GameAction[action]
            data = None
            if ga.is_complex():
                if not (isinstance(x, int) and isinstance(y, int) and 0 <= x <= 63 and 0 <= y <= 63):
                    raise Refusal("INVALID_ARGUMENT", "ACTION6 needs integer x and y in 0-63")
                data = {"x": x, "y": y}
            rs = {"text": reasoning} if reasoning else None
            if rs is not None:
                size = reasoning_bytes(rs, s.online)
                limit = arcengine.MAX_REASONING_BYTES
                if size > limit:
                    raise Refusal(
                        "INVALID_ARGUMENT",
                        f"reasoning is {size} bytes as the toolkit measures it (non-ASCII is escaped); the limit is {limit}",
                    )
            obs, records = self._call("step", lambda: s.env.step(ga, data=data, reasoning=rs))
            if obs is None:
                raise self._fail("step", records, f"{action} failed")
            return {"obs": normalize_obs(obs)}
        finally:
            s.lock.release()

    def reset(self, session_id: str) -> dict:
        # env.reset(), not step(RESET): the remote wrapper's step(RESET) omits
        # the scorecard id that reset() sends.
        s = self._locked(session_id)
        try:
            obs, records = self._call("reset", s.env.reset)
            if obs is None:
                raise self._fail("reset", records, "reset failed")
            return {"obs": normalize_obs(obs)}
        finally:
            s.lock.release()

    def close(self, session_id: str) -> dict:
        s = self._session(session_id)
        with self._sessions_lock:
            self._sessions.pop(session_id, None)
        sc, _ = self._call("close", lambda: s.arcade.close_scorecard(s.card))
        return {"scorecard": summarize_scorecard(sc)}

    def drop(self, session_id: str) -> dict:
        with self._sessions_lock:
            self._sessions.pop(session_id, None)
        return {}

    def dispatch(self, op: str, args: dict) -> dict:
        if op != "configure" and not self.configured:
            raise Refusal("NOT_CONFIGURED", "configure must come first")
        if op == "configure":
            return self.configure(args.get("api_key"), args.get("games_dir"))
        if op == "list_games":
            return self.list_games()
        if op == "open":
            return self.open(args["session_id"], args["game_id"], bool(args.get("online")))
        if op == "step":
            return self.step(args["session_id"], args["action"], args.get("x"), args.get("y"), args.get("reasoning"))
        if op == "reset":
            return self.reset(args["session_id"])
        if op == "close":
            return self.close(args["session_id"])
        if op == "drop":
            return self.drop(args["session_id"])
        raise Refusal("INVALID_ARGUMENT", "unknown op")

