import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest

from sidecar.tests._support import FAKES, SIDECAR

SCRIPT = os.path.join(SIDECAR, "arc_sidecar.py")


class Sidecar:
    """The real sidecar process on the fake toolkit, with replies by id."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        env = {"PATH": os.environ.get("PATH", ""), "CODE_ARC_TEST_TOOLKIT_DIR": FAKES}
        self.p = subprocess.Popen(
            [sys.executable, "-I", "-u", SCRIPT],
            cwd=self.tmp.name, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.lines = queue.Queue()
        self.err = []
        self.err_cond = threading.Condition()
        threading.Thread(target=self._read, args=(self.p.stdout, self.lines.put), daemon=True).start()
        threading.Thread(target=self._read, args=(self.p.stderr, self._err_line), daemon=True).start()
        self.next_id = 0

    def _err_line(self, line):
        with self.err_cond:
            self.err.append(line)
            self.err_cond.notify_all()

    def stderr_until(self, *needles, timeout=5):
        """Stderr so far, once every needle has appeared (bounded wait)."""
        with self.err_cond:
            ok = self.err_cond.wait_for(lambda: all(n in "".join(self.err) for n in needles), timeout)
            text = "".join(self.err)
        if not ok:
            raise AssertionError(f"stderr never contained {needles!r}; got {text!r}")
        return text

    @staticmethod
    def _read(stream, sink):
        for line in iter(stream.readline, b""):
            sink(line.decode("utf-8", "replace"))

    def raw(self, line: bytes):
        self.p.stdin.write(line)
        self.p.stdin.flush()

    def send(self, op, args=None):
        self.next_id += 1
        self.raw((json.dumps({"id": self.next_id, "op": op, "args": args or {}}) + "\n").encode())
        return self.next_id

    def reply(self, rid, timeout=5):
        while True:
            msg = json.loads(self.lines.get(timeout=timeout))
            if msg.get("id") == rid:
                return msg

    def call(self, op, args=None):
        return self.reply(self.send(op, args))

    def close(self):
        try:
            self.p.stdin.close()
        except OSError:
            pass
        try:
            self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait()
        self.p.stdout.close()
        self.p.stderr.close()
        self.tmp.cleanup()


class ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.sc = Sidecar()

    def tearDown(self):
        self.sc.close()

    def test_ready_event_first_with_versions(self):
        first = json.loads(self.sc.lines.get(timeout=5))
        self.assertEqual(first["event"], "ready")
        self.assertEqual(first["versions"], {"arc_agi": "0.9.9", "arcengine": "0.9.3"})

    def test_configure_must_come_first(self):
        r = self.sc.call("list_games")
        self.assertEqual((r["ok"], r["code"]), (False, "NOT_CONFIGURED"))

    def test_noisy_toolkit_does_not_corrupt_protocol(self):
        self.sc.call("configure", {"api_key": None})
        sid = "s-000000000001"
        self.assertTrue(self.sc.call("open", {"session_id": sid, "game_id": "fake-noisy", "online": False})["ok"])
        r = self.sc.call("step", {"session_id": sid, "action": "ACTION1"})
        self.assertTrue(r["ok"])
        # Every protocol line parsed; the noise went to stderr, redacted.
        err = self.sc.stderr_until("plain chatter", "Got anonymous API key: [redacted]")
        self.assertNotIn("anon-", err)

    def test_session_busy_while_a_call_is_in_flight(self):
        self.sc.call("configure", {"api_key": None})
        sid = "s-000000000002"
        self.sc.call("open", {"session_id": sid, "game_id": "fake-hang", "online": False})
        self.sc.send("step", {"session_id": sid, "action": "ACTION1"})
        r = None
        for _ in range(50):
            r = self.sc.call("step", {"session_id": sid, "action": "ACTION1"})
            if r.get("code") == "SESSION_BUSY":
                break
        self.assertEqual(r["code"], "SESSION_BUSY")

    def test_error_replies_and_malformed_lines(self):
        self.sc.call("configure", {"api_key": None})
        self.sc.raw(b"not json\n")
        r = self.sc.call("frobnicate")
        self.assertEqual((r["ok"], r["code"]), (False, "INVALID_ARGUMENT"))
        r = self.sc.call("step", {"session_id": "s-ffffffffffff", "action": "ACTION1"})
        self.assertEqual(r["code"], "SESSION_UNKNOWN")
        r = self.sc.call("open", {"session_id": "s-000000000003"})
        self.assertEqual(r["code"], "INVALID_ARGUMENT")

    def test_exits_when_stdin_closes(self):
        self.sc.p.stdin.close()
        self.assertEqual(self.sc.p.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
