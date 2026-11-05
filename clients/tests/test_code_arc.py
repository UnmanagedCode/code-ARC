"""The script client against a threaded http.server fake (no network)."""

import json
import os
import socket
import struct
import tempfile
import threading
import unittest
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from clients.code_arc import MAX_RESPONSE_BYTES, Observation, Refusal, Session, TransportError

SPEC_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "board_image.json")

TOKEN = "tok_ABC-123"


def obs_body(**extra):
    frame = ["0123456789abcdef" * 4] + ["5" * 64] * 63
    body = {
        "ok": True, "session_id": "s-0123456789ab", "game_id": "g", "mode": "local", "status": "live",
        "state": "NOT_FINISHED", "levels_completed": 0, "win_levels": 2, "available_actions": ["ACTION1", "ACTION6"],
        "step": 3, "frame_count": 1, "full_reset": False, "frame": frame,
    }
    body.update(extra)
    return body


class Fake:
    """Answers each POST with the next canned (status, body) and records the request."""

    def __init__(self):
        self.replies = []
        self.requests = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length") or 0)
                fake.requests.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(self.rfile.read(length) or b"{}")})
                status, body = fake.replies.pop(0)
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:{}/api/play/s-0123456789ab/".format(self.server.server_address[1])

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.fake = Fake()
        self.addCleanup(self.fake.close)

    def attach(self, run=1):
        self.fake.replies.append((200, obs_body(run=run)))
        return Session.attach(self.fake.base, TOKEN, "probe the click action", timeout=5)

    def test_headers_and_body(self):
        s = self.attach()
        req = self.fake.requests[0]
        self.assertTrue(req["path"].endswith("/attach"))
        headers = {k.lower(): v for k, v in req["headers"].items()}
        self.assertEqual(headers["authorization"], "Bearer " + TOKEN)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertNotIn("origin", headers)
        self.assertNotIn("sec-fetch-site", headers)
        self.assertEqual(req["body"], {"note": "probe the click action"})
        self.assertEqual(s.run, 1)
        self.assertEqual(s.session_id, "s-0123456789ab")

    def test_grid_decodes_to_ints(self):
        s = self.attach()
        g = s.last.grid
        self.assertEqual(len(g), 64)
        self.assertTrue(all(len(r) == 64 for r in g))
        self.assertEqual(g[0][:16], list(range(16)))
        self.assertEqual(g[5][7], 5)
        self.assertIsNone(Observation(obs_body(frame=None)).grid)

    def test_act_sends_run_and_coordinates(self):
        s = self.attach(run=4)
        self.fake.replies.append((200, obs_body(step=4, run=4)))
        obs = s.act("ACTION6", x=3, y=9, reasoning="why")
        self.assertEqual(self.fake.requests[-1]["body"], {"run": 4, "action": "ACTION6", "x": 3, "y": 9, "reasoning": "why"})
        self.assertEqual(obs.step, 4)
        self.assertIs(s.last, obs)
        self.fake.replies.append((200, obs_body()))
        s.act("ACTION1")
        self.assertEqual(self.fake.requests[-1]["body"], {"run": 4, "action": "ACTION1"})

    def test_note_updates_run_and_act_sends_it(self):
        s = self.attach(run=1)
        self.fake.replies.append((200, {"ok": True, "run": 2}))
        self.assertEqual(s.note("new plan"), 2)
        self.assertEqual(self.fake.requests[-1]["body"], {"run": 1, "note": "new plan"})
        self.fake.replies.append((200, obs_body()))
        s.reset()
        self.assertEqual(self.fake.requests[-1]["body"], {"run": 2})

    def test_refusal_from_ok_false_without_retry(self):
        s = self.attach()
        self.fake.replies.append((200, {"ok": False, "code": "STEP_RATE_LIMITED", "reason": "slow down", "retry_after_ms": 120}))
        with self.assertRaises(Refusal) as cm:
            s.act("ACTION1")
        self.assertEqual(cm.exception.code, "STEP_RATE_LIMITED")
        self.assertEqual(cm.exception.reason, "slow down")
        self.assertEqual(cm.exception.retry_after_ms, 120)
        self.assertEqual(cm.exception.extra, {"retry_after_ms": 120})
        self.assertEqual(len(self.fake.requests), 2, "exactly one request per refused call")

    def test_refusal_from_401(self):
        self.fake.replies.append((401, {"ok": False, "code": "TOKEN_INVALID", "reason": "bad token"}))
        with self.assertRaises(Refusal) as cm:
            Session.attach(self.fake.base, TOKEN, "n", timeout=5)
        self.assertEqual(cm.exception.code, "TOKEN_INVALID")
        self.assertIsNone(cm.exception.retry_after_ms)
        self.assertEqual(len(self.fake.requests), 1)

    def test_refusal_from_router_error_shape(self):
        s = self.attach()
        self.fake.replies.append((403, {"error": "script routes are for non-browser clients", "code": "CROSS_SITE"}))
        with self.assertRaises(Refusal) as cm:
            s.observe()
        self.assertEqual(cm.exception.code, "CROSS_SITE")
        self.assertEqual(len(self.fake.requests), 2)

    def test_5xx_and_non_json_are_transport_errors(self):
        s = self.attach()
        self.fake.replies.append((500, {"error": "internal error", "code": "INTERNAL"}))
        with self.assertRaises(TransportError):
            s.observe()
        self.fake.replies.append((200, b"<html>"))
        with self.assertRaises(TransportError):
            s.observe()

    def test_oversized_bodies_are_transport_errors(self):
        s = self.attach()
        big = b'{"ok": true, "pad": "' + b"x" * MAX_RESPONSE_BYTES + b'"}'
        self.fake.replies.append((200, big))
        with self.assertRaises(TransportError) as cm:
            s.observe()
        self.assertIn("over {} bytes".format(MAX_RESPONSE_BYTES), str(cm.exception))
        big_error = b'{"ok": false, "code": "X", "reason": "' + b"x" * MAX_RESPONSE_BYTES + b'"}'
        self.fake.replies.append((400, big_error))
        with self.assertRaises(TransportError):
            s.observe()
        self.fake.replies.append((200, obs_body(pad="x" * (MAX_RESPONSE_BYTES - 10000))))
        self.assertEqual(s.observe().step, 3, "a body under the bound still reads")

    def test_refused_connection_names_base_url(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        base = "http://127.0.0.1:{}/api/play/s-0123456789ab/".format(port)
        with self.assertRaises(TransportError) as cm:
            Session.attach(base, TOKEN, "n", timeout=5)
        self.assertIn(base, str(cm.exception))
        self.assertIn("cc's host", str(cm.exception))


def decode_png(data):
    """(width, height, px(x, y) -> (r, g, b)); 8-bit RGB, filter 0 only, CRCs checked."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    off, chunks = 8, []
    while off < len(data):
        (length,) = struct.unpack(">I", data[off:off + 4])
        kind, body = data[off + 4:off + 8], data[off + 8:off + 8 + length]
        (crc,) = struct.unpack(">I", data[off + 8 + length:off + 12 + length])
        assert zlib.crc32(kind + body) & 0xFFFFFFFF == crc, "bad CRC in {}".format(kind)
        chunks.append((kind, body))
        off += 12 + length
    width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", chunks[0][1])
    assert (depth, colour, interlace) == (8, 2, 0)
    raw = zlib.decompress(b"".join(b for k, b in chunks if k == b"IDAT"))
    stride = 1 + width * 3
    assert len(raw) == stride * height
    assert all(raw[y * stride] == 0 for y in range(height)), "non-zero filter byte"

    def px(x, y):
        i = y * stride + 1 + x * 3
        return tuple(raw[i:i + 3])

    return width, height, px


def rgb(hex_colour):
    return tuple(int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))


class SavePngTest(unittest.TestCase):
    def setUp(self):
        with open(SPEC_PATH, encoding="utf-8") as f:
            self.spec = json.load(f)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.obs = Observation(obs_body())

    def test_save_png_decodes_to_the_grid(self):
        target = os.path.relpath(os.path.join(self.tmp.name, "board.png"))
        path = self.obs.save_png(target, scale=4, grid=False)
        self.assertTrue(os.path.isabs(path))
        self.assertEqual(path, os.path.abspath(target))
        with open(path, "rb") as f:
            width, height, px = decode_png(f.read())
        self.assertEqual((width, height), (64 * 4, 64 * 4))
        palette = [rgb(c) for c in self.spec["palette"]]
        for y in range(height):
            for x in range(width):
                self.assertEqual(px(x, y), palette[self.obs.grid[y // 4][x // 4]], (x, y))
        self.assertEqual(os.listdir(self.tmp.name), ["board.png"], "no temp file left")

    def test_defaults_come_from_the_spec(self):
        path = self.obs.save_png(os.path.join(self.tmp.name, "board.png"))
        with open(path, "rb") as f:
            width, height, _ = decode_png(f.read())
        margin = self.spec["grid"]["margin"] if self.spec["grid"]["default"] else 0
        side = margin + 64 * self.spec["scale"]["default"]
        self.assertEqual((width, height), (side, side))

    def test_bad_options_and_frames_raise_and_write_nothing(self):
        lo, hi = self.spec["scale"]["min"], self.spec["scale"]["max"]
        target = os.path.join(self.tmp.name, "board.png")
        for kwargs in ({"scale": lo - 1}, {"scale": hi + 1}, {"scale": True}, {"scale": 8.0}, {"grid": "yes"}, {"grid": 1}):
            with self.assertRaises(ValueError, msg=repr(kwargs)):
                self.obs.save_png(target, **kwargs)
        with self.assertRaises(ValueError):
            Observation(obs_body(frame=None)).save_png(target)
        with self.assertRaises(ValueError):
            Observation(obs_body(frame=["01", "0"])).save_png(target)
        with self.assertRaises(ValueError):
            Observation(obs_body(frame=["0"] * 65)).save_png(target)
        self.assertEqual(os.listdir(self.tmp.name), [])


if __name__ == "__main__":
    unittest.main()
