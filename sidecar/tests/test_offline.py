"""The engine with an offline bundle's games dir (configure games_dir): the
OFFLINE bundle arcade, the merged game list, routing of opens, and the fake
toolkit's network switch (`fake-net-down` in the cwd, log in `net.jsonl`)."""

import json
import os
import tempfile
import time
import unittest

from sidecar.tests._support import TempCwd, calls, make_engine

from engine import Refusal  # noqa: E402 - path set up by _support

SID = "s-0000000000b1"


def net() -> list:
    if not os.path.exists("net.jsonl"):
        return []
    with open("net.jsonl", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def net_down() -> None:
    open("fake-net-down", "w").close()


class BundleDir:
    """A games dir laid out like a bundle's: games/<base>/<ver>/{metadata.json, fake.py}."""

    def __init__(self, games=("fake-maze",)) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, "games")
        for gid in games:
            base, ver = gid.split("-", 1)
            d = os.path.join(self.path, base, ver)
            os.makedirs(d)
            with open(os.path.join(d, "metadata.json"), "w", encoding="utf-8") as f:
                json.dump({"game_id": gid, "title": gid.title(), "tags": [], "date_downloaded": "2026-01-01T00:00:00+00:00"}, f)
            with open(os.path.join(d, base + ".py"), "w", encoding="utf-8") as f:
                f.write("# source\n")

    def __enter__(self) -> str:
        return self.path

    def __exit__(self, *exc: object) -> None:
        self._tmp.cleanup()


def bundled_engine(games_dir: str, api_key=None, wait: float = 1.0):
    engine, out = make_engine(api_key)
    engine.web_list_wait_s = wait
    engine.configure(api_key, games_dir)
    return engine, out


class OfflineBundleTest(unittest.TestCase):
    def test_bundle_games_list_and_play_with_network_down(self):
        with TempCwd(), BundleDir(("fake-maze", "fake-evil")) as gd:
            net_down()
            engine, _ = bundled_engine(gd)
            r = engine.list_games()
            self.assertEqual(sorted((g["game_id"], g["source"], g["downloaded"]) for g in r["games"]),
                             [("fake-evil", "bundle", True), ("fake-maze", "bundle", True)])
            self.assertEqual(r["web_unavailable"]["code"], "NETWORK_ERROR")
            before = net()
            self.assertTrue(before and all(not n["ok"] for n in before))
            opened = engine.open(SID, "fake-maze", False)
            self.assertEqual(opened["obs"]["state"], "NOT_FINISHED")
            self.assertEqual(len(engine.step(SID, "ACTION4")["obs"]["frame"]), 64)
            engine.close(SID)
            self.assertEqual(net(), before, "open/step/close sent nothing")
            arcades = [c for c in calls() if c["op"] == "Arcade" and c["mode"] == "offline"]
            self.assertEqual([a["environments_dir"] for a in arcades], [gd])
            self.assertIn({"op": "load_source", "game_id": "fake-maze"}, calls())

    def test_list_merges_web_games_when_reachable(self):
        with TempCwd(), BundleDir(("fake-maze",)) as gd:
            engine, _ = bundled_engine(gd)
            r = engine.list_games()
            ids = [g["game_id"] for g in r["games"]]
            self.assertEqual(r["games"][0]["game_id"], "fake-maze")
            self.assertEqual(r["games"][0]["source"], "bundle")
            self.assertTrue(all(g["source"] == "web" for g in r["games"][1:]))
            self.assertIn("fake-evil", ids)
            self.assertEqual(len(ids), len(set(ids)))
            self.assertNotIn("web_unavailable", r)

    def test_slow_web_list_does_not_block_bundle_list(self):
        with TempCwd(), BundleDir(("fake-maze",)) as gd:
            engine, _ = bundled_engine(gd, api_key="slownet-key-123", wait=0.05)
            first = engine.list_games()
            self.assertEqual([g["game_id"] for g in first["games"]], ["fake-maze"])
            self.assertEqual(first["web_unavailable"]["code"], "WEB_LIST_LOADING")
            deadline = time.monotonic() + 2.0
            while True:
                later = engine.list_games()
                if len(later["games"]) > 1:
                    break
                self.assertLess(time.monotonic(), deadline, "web games never appeared")
                time.sleep(0.02)
            self.assertIn("fake-evil", [g["game_id"] for g in later["games"]])

    def test_open_routes_bundled_ids_to_bundle_arcade_and_others_to_normal(self):
        with TempCwd() as cwd, BundleDir(("fake-maze",)) as gd:
            engine, _ = bundled_engine(gd)
            engine.open(SID, "fake-maze", False)
            engine.open("s-0000000000b2", "fake", False)
            loads = [c for c in calls() if c["op"] == "load_source"]
            self.assertEqual(len(loads), 2, "exact and base id both open from the bundle")
            self.assertFalse(os.path.exists(os.path.join(cwd, "environment_files")), "nothing downloaded")
            engine.open("s-0000000000b3", "fake-evil", False)
            self.assertEqual(len([c for c in calls() if c["op"] == "load_source"]), 2)
            self.assertTrue(os.path.exists(os.path.join(cwd, "environment_files", "fake", "evil", "metadata.json")), "NORMAL make downloaded it")
            self.assertEqual(sorted(os.listdir(os.path.join(gd, "fake"))), ["maze"], "never into the bundle")

    def test_online_open_unchanged_with_bundle(self):
        with TempCwd(), BundleDir(("fake-maze",)) as gd:
            engine, _ = bundled_engine(gd)
            net_down()
            with self.assertRaises(Refusal) as cm:
                engine.open(SID, "fake-maze", True)
            self.assertEqual(cm.exception.code, "NETWORK_ERROR")
            os.remove("fake-net-down")
            opened = engine.open(SID, "fake-maze", True)
            self.assertTrue(opened["scorecard_id"])
            self.assertTrue(any(n["mode"] == "online" and n["ok"] for n in net()))

    def test_games_dir_must_be_absolute_existing_dir(self):
        with TempCwd():
            engine, _ = make_engine()
            for bad in ("relative/games", "/no/such/dir/anywhere", 7, ""):
                with self.assertRaises(Refusal) as cm:
                    engine.configure(None, bad)
                self.assertEqual(cm.exception.code, "INVALID_ARGUMENT", bad)


if __name__ == "__main__":
    unittest.main()
