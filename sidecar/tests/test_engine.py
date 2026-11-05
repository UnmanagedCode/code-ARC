import logging
import unittest

from sidecar.tests._support import TempCwd, calls, make_engine

from engine import (  # noqa: E402 - path set up by _support
    Redactor,
    RedactFilter,
    Refusal,
    classify_failure,
    normalize_obs,
    reasoning_bytes,
)
import arc_agi  # the fake  # noqa: E402

SID = "s-0000000000a1"


class Obs:
    def __init__(self, frames, state="NOT_FINISHED"):
        self.frame = frames
        self.state = state
        self.levels_completed = 1
        self.win_levels = 3
        self.available_actions = [6, 1, 1, 9]
        self.full_reset = False


def rec(msg, exc=None, level=logging.ERROR):
    r = logging.LogRecord("t", level, __file__, 1, msg, None, (type(exc), exc, None) if exc else None)
    return r


class NormalizeTest(unittest.TestCase):
    def test_last_frame_hex_and_count(self):
        first = [[0, 0], [0, 0]]
        last = [[0, 15], [10, 5]]
        o = normalize_obs(Obs([first, last]))
        self.assertEqual(o["frame"], ["0f", "a5"])
        self.assertEqual(o["frame_count"], 2)
        self.assertEqual(o["available_actions"], [1, 6])
        self.assertEqual((o["levels_completed"], o["win_levels"], o["state"]), (1, 3, "NOT_FINISHED"))

    def test_empty_frame_is_null(self):
        o = normalize_obs(Obs([]))
        self.assertIsNone(o["frame"])
        self.assertEqual(o["frame_count"], 0)

    def test_out_of_palette_value_refused(self):
        with self.assertRaises(Refusal) as cm:
            normalize_obs(Obs([[[0, 16]]]))
        self.assertEqual(cm.exception.code, "TOOLKIT_ERROR")

    def test_non_rectangular_refused(self):
        with self.assertRaises(Refusal):
            normalize_obs(Obs([[[0, 1], [0]]]))

    def test_oversized_refused(self):
        with self.assertRaises(Refusal):
            normalize_obs(Obs([[[0]] * 65]))

    def test_enum_state_value(self):
        from arcengine import GameState

        self.assertEqual(normalize_obs(Obs([], GameState.WIN))["state"], "WIN")


class ReasoningBytesTest(unittest.TestCase):
    def test_non_ascii_is_measured_escaped(self):
        # One emoji is a surrogate pair: 😀 = 12 bytes once escaped.
        self.assertEqual(reasoning_bytes({"text": "\U0001F600"}, False), len('{"text":""}') + 12)

    def test_online_is_double_encoded(self):
        self.assertGreater(reasoning_bytes({"text": '"'}, True), reasoning_bytes({"text": '"'}, False))


class EngineOpsTest(unittest.TestCase):
    def setUp(self):
        self.cwd = TempCwd()
        self.cwd.__enter__()
        self.engine, self.log = make_engine()

    def tearDown(self):
        self.cwd.__exit__(None, None, None)

    def test_open_returns_first_frame_and_one_scorecard_per_session(self):
        a = self.engine.open(SID, "fake-maze", False)
        b = self.engine.open("s-0000000000a2", "fake-maze", False)
        self.assertEqual(a["obs"]["frame_count"], 1)
        self.assertEqual(len(a["obs"]["frame"]), 64)
        self.assertEqual(a["title"], "Fake Maze")
        cards = [c["card_id"] for c in calls() if c["op"] == "create_scorecard"]
        self.assertEqual(len(cards), 2)
        self.assertNotEqual(a["scorecard_id"], b["scorecard_id"])
        self.assertEqual([c["tags"] for c in calls() if c["op"] == "create_scorecard"][0], ["code-arc"])

    def test_reasoning_is_wrapped_as_text(self):
        self.engine.open(SID, "fake-maze", False)
        self.engine.step(SID, "ACTION4", reasoning="go right")
        step = [c for c in calls() if c["op"] == "step"][-1]
        self.assertEqual(step["reasoning"], {"text": "go right"})
        self.assertIsNone(step["data"])

    def test_no_reasoning_sends_none(self):
        self.engine.open(SID, "fake-maze", False)
        self.engine.step(SID, "ACTION4")
        self.assertIsNone([c for c in calls() if c["op"] == "step"][-1]["reasoning"])

    def test_action6_sends_coordinates(self):
        self.engine.open(SID, "fake-maze", False)
        r = self.engine.step(SID, "ACTION6", x=10, y=20)
        self.assertEqual([c for c in calls() if c["op"] == "step"][-1]["data"], {"x": 10, "y": 20})
        self.assertEqual(r["obs"]["frame"][20][10], "8")

    def test_action6_without_coordinates_refused(self):
        self.engine.open(SID, "fake-maze", False)
        with self.assertRaises(Refusal) as cm:
            self.engine.step(SID, "ACTION6")
        self.assertEqual(cm.exception.code, "INVALID_ARGUMENT")

    def test_4000_emoji_reasoning_refused_before_the_toolkit(self):
        self.engine.open(SID, "fake-maze", False)
        with self.assertRaises(Refusal) as cm:
            self.engine.step(SID, "ACTION1", reasoning="\U0001F600" * 4000)
        self.assertEqual(cm.exception.code, "INVALID_ARGUMENT")
        self.assertIn("bytes", cm.exception.detail)
        self.assertEqual([c for c in calls() if c["op"] == "step"], [])

    def test_4000_ascii_reasoning_accepted(self):
        self.engine.open(SID, "fake-maze", False)
        self.engine.step(SID, "ACTION1", reasoning="a" * 4000)
        self.assertEqual(len([c for c in calls() if c["op"] == "step"]), 1)

    def test_reset_calls_env_reset(self):
        self.engine.open(SID, "fake-maze", False)
        self.engine.step(SID, "ACTION4")
        r = self.engine.reset(SID)
        self.assertEqual(calls()[-1]["op"], "reset")
        self.assertEqual(r["obs"]["state"], "NOT_FINISHED")

    def test_close_returns_summary_and_forgets_session(self):
        self.engine.open(SID, "fake-maze", False)
        self.engine.step(SID, "ACTION4")
        r = self.engine.close(SID)
        self.assertEqual(r["scorecard"]["environments"][0]["actions"], 1)
        self.assertNotIn("api_key", r["scorecard"])
        with self.assertRaises(Refusal) as cm:
            self.engine.step(SID, "ACTION4")
        self.assertEqual(cm.exception.code, "SESSION_UNKNOWN")

    def test_unknown_game_classified(self):
        with self.assertRaises(Refusal) as cm:
            self.engine.open(SID, "nope", False)
        self.assertEqual(cm.exception.code, "GAME_UNKNOWN")

    def test_online_429_and_closed(self):
        self.engine.open(SID, "fake-429", True)
        with self.assertRaises(Refusal) as cm:
            self.engine.step(SID, "ACTION1")
        self.assertEqual(cm.exception.code, "RATE_LIMITED")
        self.engine.open("s-0000000000a3", "fake-closed", True)
        with self.assertRaises(Refusal) as cm:
            self.engine.step("s-0000000000a3", "ACTION1")
        self.assertEqual(cm.exception.code, "SCORECARD_CLOSED")

    def test_key_reaches_arcade_and_is_redacted_from_logs(self):
        engine, log = make_engine("secret-key-123456")
        engine.open(SID, "fake-maze", False)
        arcade = [c for c in calls() if c["op"] == "Arcade"][-1]
        import hashlib

        self.assertEqual(arcade["key_sha256"], hashlib.sha256(b"secret-key-123456").hexdigest())
        engine.log.warning("leak secret-key-123456")
        self.assertNotIn("secret-key-123456", log.getvalue())


class ListGamesFailureTest(unittest.TestCase):
    def setUp(self):
        self.cwd = TempCwd()
        self.cwd.__enter__()

    def tearDown(self):
        self.cwd.__exit__(None, None, None)

    def test_refused_key_fails_and_names_the_key(self):
        engine, _ = make_engine("bad-key-0123456789")
        with self.assertRaises(Refusal) as cm:
            engine.list_games()
        self.assertEqual(cm.exception.code, "TOOLKIT_ERROR")
        self.assertIn("rejected the API key (HTTP 401)", cm.exception.detail)
        self.assertNotIn("bad-key-0123456789", cm.exception.detail)
        # One Arcade per call: no duplicate construction on the failing path.
        self.assertEqual(len([c for c in calls() if c["op"] == "Arcade"]), 1)
        # The failed arcade isn't cached: the next call retries.
        with self.assertRaises(Refusal):
            engine.list_games()
        self.assertEqual(len([c for c in calls() if c["op"] == "Arcade"]), 2)

    def test_unreachable_api_is_network_error(self):
        engine, _ = make_engine("offline-0123456789")
        with self.assertRaises(Refusal) as cm:
            engine.list_games()
        self.assertEqual(cm.exception.code, "NETWORK_ERROR")

    def test_refused_key_on_open_is_not_game_unknown(self):
        engine, _ = make_engine("bad-key-0123456789")
        with self.assertRaises(Refusal) as cm:
            engine.open(SID, "fake-maze", False)
        self.assertEqual(cm.exception.code, "TOOLKIT_ERROR")
        self.assertIn("API key", cm.exception.detail)

    def test_good_key_lists_games_with_one_arcade(self):
        engine, _ = make_engine("good-key-0123456789")
        self.assertTrue(engine.list_games()["games"])
        engine.list_games()
        self.assertEqual(len([c for c in calls() if c["op"] == "Arcade"]), 1)


class ClassifyTest(unittest.TestCase):
    def test_mapping(self):
        e429 = arc_agi.HTTPError("429 Client Error", response=arc_agi._Response(429, ""))
        e_closed = arc_agi.HTTPError("400", response=arc_agi._Response(400, '{"message":"game x not found"}'))
        e_404 = arc_agi.HTTPError("404", response=arc_agi._Response(404, "scorecard c not found"))
        cases = [
            ("step", [rec("x", e429)], None, "RATE_LIMITED"),
            ("open", [rec("Failed to fetch metadata for game g (status=429): slow", level=logging.WARNING)], None, "RATE_LIMITED"),
            ("step", [], arc_agi.Timeout("Read timed out"), "NETWORK_ERROR"),
            ("list_games", [], arc_agi.ConnectionError("Max retries exceeded"), "NETWORK_ERROR"),
            ("step", [rec("x", e_closed)], None, "SCORECARD_CLOSED"),
            ("close", [], e_404, "SCORECARD_CLOSED"),
            ("open", [rec("Failed to fetch metadata for game zz (status=404): Game Not Found", level=logging.WARNING)], None, "GAME_UNKNOWN"),
            ("open", [rec("Game zz not found in scanned environments. Available games: []")], None, "GAME_UNKNOWN"),
            ("step", [rec("Error performing step with action ACTION1: boom")], None, "TOOLKIT_ERROR"),
            ("list_games", [rec("x", arc_agi.HTTPError("401 Client Error", response=arc_agi._Response(401, "")))], None, "TOOLKIT_ERROR"),
            ("open", [rec("Failed to fetch metadata for game g (status=403): no", level=logging.WARNING), rec("Game g not found in scanned environments.")], None, "TOOLKIT_ERROR"),
        ]
        for op, records, exc, want in cases:
            with self.subTest(want=want, op=op):
                self.assertEqual(classify_failure(op, records, exc), want)


class RedactTest(unittest.TestCase):
    def test_redactor_known_secret_and_anon_line(self):
        r = Redactor()
        r.add("topsecret")
        self.assertEqual(r("k=topsecret; Got anonymous API key: abc-123 done"), "k=[redacted]; Got anonymous API key: [redacted] done")

    def test_filter_redacts_message_and_traceback(self):
        r = Redactor()
        r.add("topsecret")
        try:
            raise ValueError("bad topsecret")
        except ValueError as e:
            record = logging.LogRecord("t", logging.ERROR, __file__, 1, "msg %s", ("topsecret",), (ValueError, e, e.__traceback__))
        RedactFilter(r).filter(record)
        self.assertEqual(record.getMessage(), "msg [redacted]")
        self.assertNotIn("topsecret", record.exc_text)
        self.assertIsNone(record.exc_info)


if __name__ == "__main__":
    unittest.main()
