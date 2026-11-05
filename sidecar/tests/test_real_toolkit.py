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

    def test_palette_matches_toolkit(self):
        out = subprocess.check_output([VENV_PY, "-I", "-c", "import json; from arc_agi.rendering import COLOR_MAP; print(json.dumps(COLOR_MAP))"], text=True)
        toolkit = {int(k): v for k, v in json.loads(out).items()}
        with open(os.path.join(ROOT, "frontend", "palette.js"), encoding="utf-8") as f:
            ours = {int(k): v for k, v in re.findall(r"^\s*(\d+): '(#[0-9A-F]{8})'", f.read(), re.M)}
        self.assertEqual(ours, toolkit)


if __name__ == "__main__":
    unittest.main()
