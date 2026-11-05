"""Shared fixtures for the sidecar tests: paths, a fresh cwd per test, and an
Engine wired the way arc_sidecar.main wires it, logging into a buffer."""

import io
import json
import os
import sys
import tempfile

TESTS = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.dirname(TESTS)
FAKES = os.path.join(TESTS, "fakes")
for p in (FAKES, SIDECAR):
    if p not in sys.path:
        sys.path.insert(0, p)

import arc_sidecar  # noqa: E402
from engine import Engine, Redactor  # noqa: E402


class TempCwd:
    """A fresh cwd (the fake writes calls.jsonl there) with stdout captured:
    the fake toolkit prints, as the real one can."""

    def __enter__(self) -> str:
        self._stdout = sys.stdout
        sys.stdout = io.StringIO()
        self._old = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        os.chdir(self._tmp.name)
        return self._tmp.name

    def __exit__(self, *exc: object) -> None:
        os.chdir(self._old)
        self._tmp.cleanup()
        sys.stdout = self._stdout


def make_engine(api_key=None):
    out = io.StringIO()
    redactor = Redactor()
    logger, capture, handler = arc_sidecar.setup_logging(out, redactor)
    arc_sidecar.repoint_scorecard_logger(handler, capture)
    engine = Engine(logger, capture, redactor)
    engine.configure(api_key)
    return engine, out


def calls() -> list:
    if not os.path.exists("calls.jsonl"):
        return []
    with open("calls.jsonl", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
