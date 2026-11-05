"""Test-only stand-in for the `arc_agi` toolkit.

Mirrors the real signatures the sidecar calls (Arcade, make, step, reset,
create_scorecard, close_scorecard) and the real failure shapes: calls return
None and log with exc_info, HTTP errors carry `.response.status_code/.text`,
and the message formats match what the live service produced. Plain lists
replace numpy.

Every call is appended to `calls.jsonl` in the cwd so tests can assert what
reached the toolkit. The API key is recorded as its sha256 only.

Games:
  fake-maze   background 5, border 4, player 9, goal 14. ACTION1-4 move
              (up/down/left/right, 2 frames each), ACTION6 paints a cell 8.
              Two levels: right x3 reaches the first goal, down x3 the second
              (WIN).
  fake-evil   fake-maze with a hostile title.
  fake-hang   step blocks forever.
  fake-slow   step answers after 0.4 s (a late reply).
  fake-crash  step kills the process (exit 3).
  fake-noisy  step prints to stdout, including a protocol-shaped line.
  fake-429    step fails with HTTP 429.
  fake-closed step fails the way a step on a closed scorecard does.

Keys: one starting `bad-key` is refused by /api/games with 401, one starting
`offline-` can't reach it; like the real Arcade.__init__, the failure is only
logged (with exc_info) and the game list is left empty. One starting `small-`
sees only fake-maze. One starting `slownet-` makes a NORMAL Arcade() take
0.3 s, like a slow network.

Network: every request the real toolkit would send goes through `_net`, which
appends {"path", "mode", "ok"} to `net.jsonl` in the cwd. While a file named
`fake-net-down` exists in the cwd, every request fails with the
ConnectionError the real toolkit sees when DNS fails, at the same places:
  Arcade() with no key   /api/games/anonkey, not caught (the constructor raises)
  Arcade()               /api/games, caught and logged; the list stays empty
  NORMAL make            /api/games/<id>, logged, returns None
  ONLINE make/step/reset logged, return None
  ONLINE create_scorecard / close_scorecard raise

Modes: NORMAL make (network up) writes <environments_dir>/<base>/<ver>/
metadata.json (with an absolute local_dir) and fake.py, the source only when
missing, as the real _download_game does. OFFLINE never touches the network
or writes: it scans <environments_dir> for metadata.json, and make matches an
exact id or a base id (the latest wins), needs the source file (class name, or
the base id capitalised, lowercased + .py) and records {"op": "load_source"}.
Bundled ids not in GAMES play like fake-maze.
"""

import hashlib
import json
import logging
import os
import sys
import threading
import time
import uuid
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from arcengine import ActionInput, FrameDataRaw, GameAction, GameState

# Like the real arc_agi.scorecard: a stdout handler at import, no propagation.
_module_logger = logging.getLogger("arc_agi.scorecard")
if not _module_logger.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    _module_logger.addHandler(_h)
_module_logger.setLevel(logging.INFO)
_module_logger.propagate = False

_calls_lock = threading.Lock()


def _record(entry: dict) -> None:
    with _calls_lock:
        with open("calls.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")


def _net(path: str, mode: str) -> None:
    down = os.path.exists("fake-net-down")
    with _calls_lock:
        with open("net.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"path": path, "mode": mode, "ok": not down}) + "\n")
    if down:
        raise ConnectionError(
            f"HTTPSConnectionPool(host='three.arcprize.org', port=443): Max retries exceeded with url: {path} "
            "(Caused by NameResolutionError(\"<urllib3.connection.HTTPSConnection object>: Failed to resolve "
            "'three.arcprize.org' ([Errno -3] Temporary failure in name resolution)\"))"
        )


class _Response:
    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text


# Same class names as requests.exceptions; the classifier is duck-typed.
class RequestException(Exception):
    def __init__(self, msg: str = "", response: Optional[_Response] = None) -> None:
        super().__init__(msg)
        self.response = response


class HTTPError(RequestException):
    pass


class ConnectionError(RequestException):  # noqa: A001 - mirrors requests
    pass


class Timeout(RequestException):
    pass


def _http_error(status: int, reason: str, path: str, body: str) -> HTTPError:
    return HTTPError(
        f"{status} Client Error: {reason} for url: https://three.arcprize.org{path}",
        response=_Response(status, body),
    )


class OperationMode(str, Enum):
    NORMAL = "normal"
    ONLINE = "online"
    OFFLINE = "offline"
    COMPETITION = "competition"


class EnvironmentInfo:
    def __init__(self, game_id: str, title: Optional[str] = None, tags: Optional[list] = None, local_dir: Optional[str] = None,
                 date_downloaded: str = "", class_name: Optional[str] = None) -> None:
        self.game_id = game_id
        self.title = title
        self.tags = tags
        self.local_dir = local_dir
        self.date_downloaded = date_downloaded
        self.class_name = class_name


GAMES = {
    "fake-maze": ("Fake Maze", ["keyboard", "click"]),
    "fake-evil": ("Evil <img src=x onerror=alert(1)>", ["click"]),
    "fake-hang": ("Fake Hang", []),
    "fake-slow": ("Fake Slow", []),
    "fake-crash": ("Fake Crash", []),
    "fake-noisy": ("Fake Noisy", []),
    "fake-429": ("Fake 429", []),
    "fake-closed": ("Fake Closed", []),
}

SIZE = 64
BG, BORDER, PLAYER, GOAL, PAINT, SHADOW = 5, 4, 9, 14, 8, 3
GOALS = [(5, 2), (2, 5)]
MOVES = {1: (0, -1), 2: (0, 1), 3: (-1, 0), 4: (1, 0)}


class _Game:
    def __init__(self, game_id: str) -> None:
        self.game_id = game_id
        self.full()

    def full(self) -> None:
        self.level = 0
        self.state = GameState.NOT_FINISHED
        self.paint: dict = {}
        self.player = (2, 2)

    def grid(self, shadow: Optional[tuple] = None) -> list:
        g = [[BG] * SIZE for _ in range(SIZE)]
        for i in range(SIZE):
            g[0][i] = g[SIZE - 1][i] = g[i][0] = g[i][SIZE - 1] = BORDER
        for (x, y), c in self.paint.items():
            g[y][x] = c
        if self.level < len(GOALS):
            gx, gy = GOALS[self.level]
            g[gy][gx] = GOAL
        if shadow is not None:
            g[shadow[1]][shadow[0]] = SHADOW
        px, py = self.player
        g[py][px] = PLAYER
        return g


class _Wrapper:
    def __init__(self, arcade: "Arcade", info: EnvironmentInfo, scorecard_id: str, behaviour: Optional[str] = None) -> None:
        self.arcade = arcade
        self.environment_info = info
        # Which GAMES entry this plays like (bundled ids are not in GAMES).
        self.behaviour = behaviour or info.game_id
        self.scorecard_id = scorecard_id
        self.logger = arcade.logger
        self.game = _Game(info.game_id)
        self.actions = 0
        self.resets = 0
        self._last: Optional[FrameDataRaw] = None
        self.reset()

    @property
    def observation_space(self) -> Optional[FrameDataRaw]:
        return self._last

    def _obs(self, frames: list, full_reset: bool = False, action_input: Optional[ActionInput] = None) -> FrameDataRaw:
        o = FrameDataRaw()
        o.game_id = self.environment_info.game_id
        o.state = self.game.state
        o.levels_completed = self.game.level
        o.win_levels = len(GOALS)
        o.available_actions = [1, 2, 3, 4, 6]
        o.full_reset = full_reset
        o.frame = frames
        o.guid = "guid-" + self.scorecard_id
        if action_input is not None:
            o.action_input = action_input
        self._last = o
        self.arcade._activity(self.scorecard_id, self)
        return o

    def _online_net(self, path: str) -> bool:
        if self.arcade.operation_mode != OperationMode.ONLINE:
            return True
        try:
            _net(path, "online")
            return True
        except ConnectionError as e:
            self.logger.error(f"Failed to send {path}: {e}", exc_info=(type(e), e, None))
            return False

    def reset(self) -> Optional[FrameDataRaw]:
        _record({"op": "reset", "game_id": self.environment_info.game_id})
        if not self._online_net("/api/cmd/RESET"):
            return None
        full = self.actions == 0 or self.game.state == GameState.WIN
        if full:
            self.game.full()
            self.actions = 0
        else:
            self.game.player = (2, 2)
            self.game.state = GameState.NOT_FINISHED
        self.resets += 1
        return self._obs([self.game.grid()], full_reset=full)

    def step(self, action: GameAction, data: Optional[dict] = None, reasoning: Optional[dict] = None) -> Optional[FrameDataRaw]:
        _record({"op": "step", "game_id": self.environment_info.game_id, "action": action.name, "data": data, "reasoning": reasoning})
        gid = self.behaviour
        try:
            ai = ActionInput(id=action, data=data or {}, reasoning=reasoning)
        except Exception as e:
            self.logger.exception(f"Error performing step with action {action.name}: {e}")
            return None
        if not self._online_net(f"/api/cmd/{action.name}"):
            return None
        if gid == "fake-hang":
            threading.Event().wait()
        if gid == "fake-slow":
            time.sleep(0.4)
        if gid == "fake-crash":
            os._exit(3)
        if gid == "fake-noisy":
            print('{"id": 1, "ok": true, "result": {"noise": true}}')
            print("fake-noisy: plain chatter on stdout")
            sys.stdout.flush()
        if gid == "fake-429":
            e = _http_error(429, "Too Many Requests", f"/api/cmd/{action.name}", '{"error":"RATE_LIMITED"}')
            self.logger.error(f"Failed to perform action {action.name} for game {gid}: {e}", exc_info=(type(e), e, None))
            return None
        if gid == "fake-closed":
            body = '{"error":"SERVER_ERROR","message":"game ' + gid + ' not found"}'
            e = _http_error(400, "Bad Request", f"/api/cmd/{action.name}", body)
            self.logger.error(f"Failed to perform action {action.name} for game {gid}: {e} Response body: {body}", exc_info=(type(e), e, None))
            return None
        g = self.game
        if g.state in (GameState.WIN, GameState.GAME_OVER):
            # The real engine's terminal-state behaviour: empty frame, levels zeroed.
            o = FrameDataRaw()
            o.state = g.state
            return o
        self.actions += 1
        if action.value in MOVES:
            dx, dy = MOVES[action.value]
            old = g.player
            nx, ny = old[0] + dx, old[1] + dy
            if 0 < nx < SIZE - 1 and 0 < ny < SIZE - 1:
                g.player = (nx, ny)
            mid = g.grid(shadow=old)
            if g.level < len(GOALS) and g.player == GOALS[g.level]:
                g.level += 1
                g.player = (2, 2)
                if g.level == len(GOALS):
                    g.state = GameState.WIN
            return self._obs([mid, g.grid()], action_input=ai)
        if action == GameAction.ACTION6:
            g.paint[(int(data["x"]), int(data["y"]))] = PAINT
            return self._obs([g.grid()], action_input=ai)
        return self._obs([g.grid()], action_input=ai)


class _Scorecard:
    def __init__(self, card_id: str, envs: list) -> None:
        self.card_id = card_id
        self.envs = envs

    def model_dump(self, exclude_none: bool = True) -> dict:
        environments = []
        for w in self.envs:
            environments.append({
                "id": w.environment_info.game_id,
                "score": 50.0 * w.game.level,
                "actions": w.actions,
                "levels_completed": w.game.level,
                "completed": w.game.state == GameState.WIN,
                "level_count": len(GOALS),
                "resets": w.resets,
                "runs": [{"guid": "g", "score": 0.0}],
            })
        return {
            "card_id": self.card_id,
            "score": sum(e["score"] for e in environments),
            "environments": environments,
            "total_levels_completed": sum(e["levels_completed"] for e in environments),
            "total_levels": len(GOALS) * len(environments),
            "total_actions": sum(e["actions"] for e in environments),
            "api_key": None,
        }


def _source_name(meta: dict, base: str) -> str:
    cls = meta.get("class_name") or (base[0].upper() + base[1:] if base else "Game")
    return cls.lower() + ".py"


class Arcade:
    def __init__(
        self,
        arc_api_key: str = "",
        arc_base_url: str = "https://three.arcprize.org",
        operation_mode: OperationMode = OperationMode.NORMAL,
        environments_dir: str = "environment_files",
        recordings_dir: str = "recordings",
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self.operation_mode = operation_mode
        self.environments_dir = environments_dir
        self.logger = logger or logging.getLogger("arc_agi.base")
        key = arc_api_key or os.getenv("ARC_API_KEY", "")
        mode = operation_mode.value
        _record({
            "op": "Arcade",
            "mode": mode,
            "environments_dir": environments_dir,
            "key_sha256": hashlib.sha256(key.encode()).hexdigest() if key else None,
            "env_arc_vars": sorted(k for k in os.environ if k.startswith("ARC_") or k in ("OPERATION_MODE", "ENVIRONMENTS_DIR", "RECORDINGS_DIR")),
        })
        self._cards: dict = {}
        self._closed: set = set()
        self._lock = threading.Lock()
        self._games_error: Optional[str] = None
        self._scanned: list = self._scan() if operation_mode == OperationMode.OFFLINE else []
        if operation_mode == OperationMode.OFFLINE:
            self.arc_api_key = key
            return
        if not key:
            # Like the real _get_anonymous_api_key: outside any try.
            _net("/api/games/anonkey", mode)
            key = "anon-" + uuid.uuid4().hex
            # The real toolkit logs this through the passed logger at INFO; the
            # stdout print is the stress case for redaction of raw output.
            self.logger.info(f"Got anonymous API key: {key}")
            print(f"Got anonymous API key: {key}")
            _module_logger.warning(f"Got anonymous API key: {key}")
        self.arc_api_key = key
        if key.startswith("slownet-") and operation_mode == OperationMode.NORMAL:
            time.sleep(0.3)
        url = f"{arc_base_url}/api/games"
        e: Optional[Exception] = None
        try:
            _net("/api/games", mode)
        except ConnectionError as ce:
            e = ce
            self._games_error = "offline"
        if e is None and key.startswith("bad-key"):
            e = _http_error(401, "Unauthorized", "/api/games", '{"error":"UNAUTHORIZED"}')
            self._games_error = "401"
        elif e is None and key.startswith("offline-"):
            e = ConnectionError(f"HTTPSConnectionPool(host='three.arcprize.org', port=443): Max retries exceeded with url: /api/games")
            self._games_error = "offline"
        if self._games_error:
            self.logger.error(f"Failed to fetch environments from API ({url}): {e}", exc_info=(type(e), e, None))

    def _scan(self) -> list:
        found = []
        root = Path(self.environments_dir)
        if not root.is_dir():
            return found
        for meta_file in sorted(root.rglob("metadata.json")):
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                info = EnvironmentInfo(str(meta["game_id"]), meta.get("title"), list(meta.get("tags") or []), str(meta_file.parent),
                                       str(meta.get("date_downloaded") or ""), meta.get("class_name"))
            except Exception as e:  # noqa: BLE001 - mirrors the real scan
                self.logger.warning(f"Failed to load metadata.json from {meta_file}: {e}", exc_info=(type(e), e, None))
                continue
            found.append(info)
        return found

    def get_environments(self) -> list:
        if self.operation_mode == OperationMode.OFFLINE:
            return list(self._scanned)
        if self._games_error:
            return []
        games = {"fake-maze": GAMES["fake-maze"]} if self.arc_api_key.startswith("small-") else GAMES
        return [EnvironmentInfo(gid, title, list(tags), None) for gid, (title, tags) in games.items()]

    def create_scorecard(self, source_url: Optional[str] = None, tags: Optional[list] = None, opaque: Any = None) -> str:
        if self.operation_mode == OperationMode.ONLINE:
            _net("/api/scorecard/open", "online")
        card = str(uuid.uuid4())
        _record({"op": "create_scorecard", "mode": self.operation_mode.value, "tags": tags, "card_id": card})
        with self._lock:
            self._cards[card] = []
        return card

    def close_scorecard(self, scorecard_id: Optional[str] = None) -> Optional[_Scorecard]:
        _record({"op": "close_scorecard", "card_id": scorecard_id})
        if self.operation_mode == OperationMode.ONLINE:
            _net("/api/scorecard/close", "online")
        with self._lock:
            if scorecard_id in self._closed or scorecard_id not in self._cards:
                body = '{"error":"VALIDATION_ERROR","message":"scorecard ' + str(scorecard_id) + ' not found"}'
                raise _http_error(404, "Not Found", "/api/scorecard/close", body)
            self._closed.add(scorecard_id)
            return _Scorecard(scorecard_id, self._cards[scorecard_id])

    def _activity(self, card: str, wrapper: _Wrapper) -> None:
        with self._lock:
            envs = self._cards.setdefault(card, [])
            if wrapper not in envs:
                envs.append(wrapper)

    def _make_offline(self, game_id: str, scorecard_id: Optional[str]) -> Optional[_Wrapper]:
        base = game_id.split("-", 1)[0]
        exact = [e for e in self._scanned if e.game_id == game_id]
        matches = exact or [e for e in self._scanned if e.game_id.split("-", 1)[0] == base]
        if not matches:
            self.logger.error(f"Game {base} not found in scanned environments. Available games: {sorted({e.game_id.split('-', 1)[0] for e in self._scanned})}")
            return None
        info = sorted(matches, key=lambda e: e.date_downloaded)[-1]
        source = Path(info.local_dir) / _source_name({"class_name": info.class_name}, info.game_id.split("-", 1)[0])
        if not source.is_file():
            self.logger.error(f"Failed to create LocalEnvironmentWrapper for {info.game_id}: no source file {source.name}")
            return None
        source.read_text(encoding="utf-8")
        _record({"op": "load_source", "game_id": info.game_id})
        behaviour = info.game_id if info.game_id in GAMES else "fake-maze"
        return _Wrapper(self, info, scorecard_id or "default", behaviour)

    def _download(self, game_id: str, title: str, tags: list) -> str:
        """Writes the game's files the way the real _download_game does."""
        base, _, ver = game_id.partition("-")
        env_dir = Path(self.environments_dir) / base
        if ver:
            env_dir = env_dir / ver
        env_dir.mkdir(parents=True, exist_ok=True)
        meta = {"game_id": game_id, "title": title, "tags": tags, "baseline_actions": [], "local_dir": str(env_dir),
                "date_downloaded": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}
        (env_dir / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        source = env_dir / _source_name(meta, base)
        if not source.exists():
            source.write_text(f"# fake game source for {game_id}\n", encoding="utf-8")
        return str(env_dir)

    def make(
        self,
        game_id: str,
        seed: int = 0,
        scorecard_id: Optional[str] = None,
        save_recording: bool = False,
        include_frame_data: bool = True,
        render_mode: Optional[str] = None,
        renderer: Any = None,
    ) -> Optional[_Wrapper]:
        _record({"op": "make", "game_id": game_id, "scorecard_id": scorecard_id, "save_recording": save_recording})
        if self.operation_mode == OperationMode.OFFLINE:
            return self._make_offline(game_id, scorecard_id)
        try:
            _net(f"/api/games/{game_id}", self.operation_mode.value)
        except ConnectionError as e:
            self.logger.error(f"Request error while fetching metadata for game {game_id}: {e}", exc_info=(type(e), e, None))
            return None
        if self._games_error == "401":
            self.logger.warning("Failed to fetch metadata for game %s (status=%s): %s", game_id, 401, "Unauthorized")
            self.logger.error(f"Game {game_id} not found in scanned environments. Available games: []")
            return None
        if game_id not in GAMES:
            self.logger.warning("Failed to fetch metadata for game %s (status=%s): %s", game_id, 404, "Game Not Found")
            return None
        title, tags = GAMES[game_id]
        local_dir = self._download(game_id, title, list(tags)) if self.operation_mode == OperationMode.NORMAL else None
        info = EnvironmentInfo(game_id, title, list(tags), local_dir)
        return _Wrapper(self, info, scorecard_id or "default")
