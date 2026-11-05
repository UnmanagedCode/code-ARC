"""Test-only stand-in for `arcengine`: the names the sidecar uses, with the
real signatures and validation, on plain lists instead of numpy."""

import json
from enum import Enum
from typing import Any, Optional

MAX_REASONING_BYTES = 16 * 1024
MAX_FRAME_PER_ACTION = 1000


class GameState(str, Enum):
    NOT_PLAYED = "NOT_PLAYED"
    NOT_FINISHED = "NOT_FINISHED"
    WIN = "WIN"
    GAME_OVER = "GAME_OVER"


class GameAction(Enum):
    RESET = 0
    ACTION1 = 1
    ACTION2 = 2
    ACTION3 = 3
    ACTION4 = 4
    ACTION5 = 5
    ACTION6 = 6
    ACTION7 = 7

    def is_complex(self) -> bool:
        return self is GameAction.ACTION6

    @classmethod
    def from_id(cls, action_id: int) -> "GameAction":
        return cls(action_id)


class ActionInput:
    """Mirrors arcengine.ActionInput's reasoning guard exactly."""

    def __init__(self, id: GameAction = GameAction.RESET, data: Optional[dict] = None, reasoning: Any = None):
        if reasoning is not None:
            raw = json.dumps(reasoning, separators=(",", ":")).encode("utf-8")
            if len(raw) > MAX_REASONING_BYTES:
                raise ValueError(f"reasoning exceeds {MAX_REASONING_BYTES} bytes")
        self.id = id
        self.data = data or {}
        self.reasoning = reasoning


class FrameDataRaw:
    def __init__(self) -> None:
        self.game_id = ""
        self.state = GameState.NOT_PLAYED
        self.levels_completed = 0
        self.win_levels = 0
        self.action_input = ActionInput()
        self.guid: Optional[str] = None
        self.full_reset = False
        self.available_actions: list = []
        self.frame: list = []
