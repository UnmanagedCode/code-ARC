"""Real-toolkit smoke test: the sidecar in the bootstrapped .venv against the
live arcprize.org service (NORMAL mode). Needs network; gated behind
RUN_REAL_ARC=1 and skipped otherwise."""

import json
import os
import re
import subprocess
import tempfile
import unittest

from sidecar.tests._support import SIDECAR

ROOT = os.path.dirname(SIDECAR)
VENV_PY = os.path.join(ROOT, ".venv", "bin", "python")
SCRIPT = os.path.join(SIDECAR, "arc_sidecar.py")


@unittest.skipUnless(os.environ.get("RUN_REAL_ARC") == "1", "set RUN_REAL_ARC=1 (needs network and the bootstrapped .venv)")
class RealToolkitTest(unittest.TestCase):
    def test_list_make_step_close(self):
        self.assertTrue(os.path.exists(VENV_PY), "bootstrap the .venv first: node scripts/setup.mjs")
        sid = "s-00000000beef"
        reqs = [
            {"id": 1, "op": "configure", "args": {"api_key": None}},
            {"id": 2, "op": "list_games", "args": {}},
        ]
        with tempfile.TemporaryDirectory() as cwd:
            p = subprocess.Popen([VENV_PY, "-I", "-u", SCRIPT], cwd=cwd, env={"PATH": os.environ.get("PATH", "")},
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                def call(req):
                    p.stdin.write(json.dumps(req) + "\n")
                    p.stdin.flush()
                    while True:
                        msg = json.loads(p.stdout.readline())
                        if msg.get("id") == req["id"]:
                            return msg

                ready = json.loads(p.stdout.readline())
                self.assertEqual(ready["versions"]["arc_agi"], "0.9.9")
                for req in reqs:
                    r = call(req)
                    self.assertTrue(r["ok"], r)
                games = r["result"]["games"]
                self.assertGreater(len(games), 0)
                game = games[0]["game_id"]
                r = call({"id": 3, "op": "open", "args": {"session_id": sid, "game_id": game, "online": False}})
                self.assertTrue(r["ok"], r)
                obs = r["result"]["obs"]
                self.assertEqual(len(obs["frame"]), 64)
                self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", row) for row in obs["frame"]))
                act = "ACTION%d" % obs["available_actions"][0]
                args = {"session_id": sid, "action": act, "reasoning": "smoke test"}
                if act == "ACTION6":
                    args.update(x=32, y=32)
                r = call({"id": 4, "op": "step", "args": args})
                self.assertTrue(r["ok"], r)
                r = call({"id": 5, "op": "close", "args": {"session_id": sid}})
                self.assertTrue(r["ok"], r)
                self.assertIn("score", r["result"]["scorecard"])
            finally:
                p.stdin.close()
                p.wait(timeout=10)
            err = p.stderr.read()
            p.stdout.close()
            p.stderr.close()
            self.assertNotRegex(err, r"Got anonymous API key: (?!\[redacted\])")

    def test_offline_arcade_over_downloaded_game_makes_no_network_calls(self):
        """The bundle's premise on the real toolkit: a game a NORMAL arcade
        downloaded lists, makes and steps on an OFFLINE arcade with every
        socket call guarded (sidecar/tests/netguard.py)."""
        self.assertTrue(os.path.exists(VENV_PY), "bootstrap the .venv first: node scripts/setup.mjs")
        probe = """
import json, sys
sys.path.insert(0, sys.argv[1])
import netguard
from arc_agi import Arcade, OperationMode
from arcengine import GameAction
games = sys.argv[2]
normal = Arcade(operation_mode=OperationMode.NORMAL, environments_dir=games)
gid = normal.get_environments()[0].game_id
assert normal.make(gid) is not None, "download failed"
netguard.install()
try:
    offline = Arcade(operation_mode=OperationMode.OFFLINE, environments_dir=games)
    listed = [e.game_id for e in offline.get_environments()]
    env = offline.make(gid)
    assert env is not None, "offline make failed"
    action = GameAction.from_id(env.observation_space.available_actions[0])
    data = {"x": 32, "y": 32} if action.is_complex() else None
    obs = env.step(action, data=data)
finally:
    netguard.uninstall()
print(json.dumps({"game": gid, "listed": listed, "stepped": obs is not None}))
"""
        with tempfile.TemporaryDirectory() as cwd:
            games = os.path.join(cwd, "games")
            out = subprocess.run([VENV_PY, "-I", "-c", probe, os.path.join(SIDECAR, "tests"), games], cwd=cwd,
                                 env={"PATH": os.environ.get("PATH", "")}, capture_output=True, text=True, timeout=120)
            self.assertEqual(out.returncode, 0, out.stderr[-2000:])
            r = json.loads(out.stdout.strip().splitlines()[-1])
            self.assertIn(r["game"], r["listed"])
            self.assertTrue(r["stepped"])
            self.assertNotIn("netguard:", out.stderr)

    def test_palette_matches_toolkit(self):
        out = subprocess.check_output([VENV_PY, "-I", "-c", "import json; from arc_agi.rendering import COLOR_MAP; print(json.dumps(COLOR_MAP))"], text=True)
        toolkit = {int(k): v for k, v in json.loads(out).items()}
        with open(os.path.join(ROOT, "frontend", "palette.js"), encoding="utf-8") as f:
            ours = {int(k): v for k, v in re.findall(r"^\s*(\d+): '(#[0-9A-F]{8})'", f.read(), re.M)}
        self.assertEqual(ours, toolkit)
        with open(os.path.join(ROOT, "src", "board_image.json"), encoding="utf-8") as f:
            image = json.load(f)["palette"]
        self.assertEqual({i: c + "FF" for i, c in enumerate(image)}, toolkit)


if __name__ == "__main__":
    unittest.main()
