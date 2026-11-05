"""Code ARC sidecar: drives the arc-agi toolkit for the Node backend over JSON
lines. Requests arrive on stdin, replies leave on a dup of the original fd 1;
fd 1 itself is pointed at stderr so toolkit prints and its stdout log handlers
never reach the protocol stream.

Request  {"id": n, "op": str, "args": {}}
Reply    {"id": n, "ok": true, "result": {}} | {"id": n, "ok": false, "code": str, "detail": str}
Startup  {"event": "ready", "versions": {"arc_agi": str|null, "arcengine": str|null}}
"""

import io
import json
import logging
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
# -I drops the script dir from sys.path; add it back explicitly.
sys.path.insert(0, HERE)
# Test-only seam: a directory holding fake arc_agi/arcengine packages.
_TEST_TOOLKIT = os.environ.get("CODE_ARC_TEST_TOOLKIT_DIR")
if _TEST_TOOLKIT:
    sys.path.insert(0, _TEST_TOOLKIT)

from engine import CaptureHandler, Engine, RedactFilter, Redactor, Refusal  # noqa: E402

LINE_MAX = 1024 * 1024


class RedactingWriter(io.TextIOBase):
    """A text stream that redacts each write before passing it on."""

    def __init__(self, target: io.TextIOBase, redactor: Redactor) -> None:
        self._target = target
        self._redactor = redactor
        self._lock = threading.Lock()

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
        with self._lock:
            self._target.write(self._redactor(s))
            self._target.flush()
        return len(s)

    def flush(self) -> None:
        self._target.flush()

    def fileno(self) -> int:
        return self._target.fileno()


def isolate_stdout() -> io.TextIOBase:
    """Returns the protocol stream; afterwards fd 1 is stderr."""
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    return os.fdopen(proto_fd, "w", buffering=1, encoding="utf-8")


def setup_logging(err: io.TextIOBase, redactor: Redactor) -> tuple:
    handler = logging.StreamHandler(err)
    handler.setLevel(logging.WARNING)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    rf = RedactFilter(redactor)
    handler.addFilter(rf)
    capture = CaptureHandler()

    logger = logging.getLogger("code_arc.toolkit")
    logger.handlers.clear()
    logger.filters.clear()
    logger.setLevel(logging.WARNING)
    logger.propagate = False
    logger.addFilter(rf)
    logger.addHandler(handler)
    logger.addHandler(capture)

    # The toolkit's scorecard module logger writes to stdout and doesn't
    # propagate; point it at our redacted stderr handler (and the capture).
    sc = logging.getLogger("arc_agi.scorecard")
    sc.filters.clear()
    sc.addFilter(rf)
    return logger, capture, handler


def repoint_scorecard_logger(handler: logging.Handler, capture: CaptureHandler) -> None:
    sc = logging.getLogger("arc_agi.scorecard")
    for h in list(sc.handlers):
        sc.removeHandler(h)
    sc.addHandler(handler)
    sc.addHandler(capture)
    sc.propagate = False


def versions() -> dict:
    from importlib import metadata

    out = {}
    for dist, key in (("arc-agi", "arc_agi"), ("arcengine", "arcengine")):
        try:
            out[key] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            out[key] = None
    return out


def main() -> None:
    proto = isolate_stdout()
    redactor = Redactor()
    err = RedactingWriter(sys.__stderr__, redactor)
    sys.stdout = err
    sys.stderr = err
    logger, capture, handler = setup_logging(err, redactor)
    engine = Engine(logger, capture, redactor)
    write_lock = threading.Lock()
    repointed = threading.Event()
    import_lock = threading.Lock()

    def send(obj: dict) -> None:
        line = json.dumps(obj, separators=(",", ":"))
        with write_lock:
            proto.write(line + "\n")
            proto.flush()

    def handle(req: dict) -> None:
        rid = req.get("id")
        try:
            op = req.get("op")
            args = req.get("args") or {}
            if not isinstance(args, dict):
                raise Refusal("INVALID_ARGUMENT", "args must be an object")
            if op != "configure" and not repointed.is_set():
                # First toolkit-touching op: import now and take over the
                # scorecard logger's stdout handler it attached at import.
                with import_lock:
                    if not repointed.is_set():
                        try:
                            engine._toolkit()
                        except Exception as e:  # noqa: BLE001
                            raise Refusal("TOOLKIT_ERROR", redactor(f"cannot import the toolkit: {type(e).__name__}: {e}")[:300])
                        repoint_scorecard_logger(handler, capture)
                        repointed.set()
            send({"id": rid, "ok": True, "result": engine.dispatch(op, args)})
        except Refusal as r:
            send({"id": rid, "ok": False, "code": r.code, "detail": redactor(r.detail)[:300]})
        except KeyError as e:
            send({"id": rid, "ok": False, "code": "INVALID_ARGUMENT", "detail": f"missing argument {e}"})
        except Exception as e:  # noqa: BLE001 - reply, never die on one request
            send({"id": rid, "ok": False, "code": "TOOLKIT_ERROR", "detail": redactor(f"{type(e).__name__}: {e}")[:300]})

    send({"event": "ready", "versions": versions()})

    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline(LINE_MAX + 1)
        if not line:
            break
        if len(line) > LINE_MAX:
            logger.error("request line over the size limit; exiting")
            break
        try:
            req = json.loads(line)
        except ValueError:
            logger.error("malformed request line ignored")
            continue
        if not isinstance(req, dict):
            continue
        threading.Thread(target=handle, args=(req,), daemon=True).start()
    # stdin closed: the backend is gone. Don't wait on hung toolkit threads.
    os._exit(0)


if __name__ == "__main__":
    main()
