"""sidecar/bundle_games.py, the export helper, run as the exporter runs it:
`python3 -I bundle_games.py` with the request on stdin, over the fake toolkit."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

from sidecar.tests._support import FAKES, SIDECAR

SCRIPT = os.path.join(SIDECAR, "bundle_games.py")


def run_helper(api_key, environments_dir, cwd):
    p = subprocess.run(
        [sys.executable, "-I", SCRIPT],
        input=json.dumps({"api_key": api_key, "environments_dir": environments_dir}) + "\n",
        cwd=cwd, env={"PATH": os.environ.get("PATH", ""), "CODE_ARC_TEST_TOOLKIT_DIR": FAKES},
        capture_output=True, text=True, timeout=60,
    )
    return p.returncode, json.loads(p.stdout.strip().splitlines()[-1]), p.stderr


class BundleGamesTest(unittest.TestCase):
    def test_downloads_every_game_and_strips_local_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            games = os.path.join(tmp, "games")
            run = os.path.join(tmp, "run")
            os.mkdir(games)
            os.mkdir(run)
            code, reply, err = run_helper(None, games, run)
            self.assertEqual(code, 0, err)
            self.assertTrue(reply["ok"], reply)
            import arc_agi  # the fake  # noqa: PLC0415

            self.assertEqual(sorted(g["game_id"] for g in reply["games"]), sorted(arc_agi.GAMES))
            for g in reply["games"]:
                self.assertTrue(g["dir"].startswith("games/"), g)
                d = os.path.join(tmp, *g["dir"].split("/"))
                self.assertEqual(sorted(os.listdir(d)), ["fake.py", "metadata.json"])
                with open(os.path.join(d, "metadata.json"), encoding="utf-8") as f:
                    meta = json.load(f)
                self.assertEqual(meta["game_id"], g["game_id"])
                self.assertNotIn("local_dir", meta)
            self.assertNotRegex(err, r"Got anonymous API key: (?!\[redacted\])")

    def test_fails_when_games_cannot_be_listed(self):
        key = "bad-key-very-secret-0042"
        with tempfile.TemporaryDirectory() as tmp:
            games = os.path.join(tmp, "games")
            os.mkdir(games)
            code, reply, err = run_helper(key, games, tmp)
            self.assertEqual(code, 1)
            self.assertFalse(reply["ok"])
            self.assertEqual(reply["code"], "EXPORT_FAILED")
            self.assertIn("listed no games", reply["detail"])
            self.assertNotIn(key, reply["detail"] + err)
            self.assertEqual(os.listdir(games), [])


if __name__ == "__main__":
    unittest.main()
