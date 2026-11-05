"""Bundle export helper: downloads every game the toolkit lists into a
bundle's games dir. Run by src/bundleExport.js on the exporting machine; the
backend never runs it.

stdin   {"api_key": str|null, "environments_dir": absolute path}
stdout  one line: {"ok": true, "games": [{"game_id", "title", "dir": "games/<rel>"}]}
        or {"ok": false, "code": "EXPORT_FAILED", "detail": str} (exit 1)

Each game is fetched with a NORMAL-mode make(), which loads its source and runs
it once (its first reset) on the export host, as local play does. The
`local_dir` the toolkit writes into each metadata.json (an absolute path on
this host) is removed; the OFFLINE arcade that reads the bundle derives it
from where metadata.json is.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# -I drops the script dir from sys.path; add it back explicitly.
sys.path.insert(0, HERE)

import arc_sidecar  # noqa: E402 - also applies the CODE_ARC_TEST_TOOLKIT_DIR seam
from engine import DETAIL_MAX, GAME_ID_RE, TITLE_MAX, Redactor  # noqa: E402

REQUEST_MAX = 64 * 1024


class ExportFailed(Exception):
    pass


def download_all(arc_agi, logger, redactor, key: str, environments_dir: str) -> list:
    arcade = arc_agi.Arcade(arc_api_key=key, operation_mode=arc_agi.OperationMode.NORMAL, environments_dir=environments_dir, logger=logger)
    redactor.add(getattr(arcade, "arc_api_key", None))
    envs = arcade.get_environments()
    if not envs:
        raise ExportFailed("the toolkit listed no games (see the log above)")
    root = os.path.realpath(environments_dir)
    games = []
    for info in envs:
        gid = str(getattr(info, "game_id", "") or "")
        if not GAME_ID_RE.match(gid):
            raise ExportFailed(f"the toolkit listed a malformed game id {gid[:80]!r}")
        env = arcade.make(gid)
        local = getattr(getattr(env, "environment_info", None), "local_dir", None) if env is not None else None
        if not local:
            raise ExportFailed(f"could not download game {gid} (see the log above)")
        local = os.path.realpath(local)
        rel = os.path.relpath(local, root)
        if rel.startswith("..") or os.path.isabs(rel) or rel == ".":
            raise ExportFailed(f"game {gid} was written outside the bundle ({local})")
        meta_file = os.path.join(local, "metadata.json")
        with open(meta_file, encoding="utf-8") as f:
            meta = json.load(f)
        meta.pop("local_dir", None)
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        title = str(getattr(info, "title", None) or gid)[:TITLE_MAX]
        games.append({"game_id": gid, "title": title, "dir": "games/" + rel.replace(os.sep, "/")})
    return games


def main() -> None:
    proto = arc_sidecar.isolate_stdout()
    redactor = Redactor()
    err = arc_sidecar.RedactingWriter(sys.__stderr__, redactor)
    sys.stdout = err
    sys.stderr = err
    logger, capture, handler = arc_sidecar.setup_logging(err, redactor)

    def reply(obj: dict) -> None:
        proto.write(json.dumps(obj, separators=(",", ":")) + "\n")
        proto.flush()

    try:
        req = json.loads(sys.stdin.readline(REQUEST_MAX))
        key = req.get("api_key") or ""
        redactor.add(key)
        environments_dir = req["environments_dir"]
        if not isinstance(environments_dir, str) or not os.path.isabs(environments_dir) or not os.path.isdir(environments_dir):
            raise ExportFailed("environments_dir must be an existing absolute directory")
        import arc_agi  # noqa: PLC0415 - heavy; after stdout is isolated

        arc_sidecar.repoint_scorecard_logger(handler, capture)
        games = download_all(arc_agi, logger, redactor, key, environments_dir)
    except Exception as e:  # noqa: BLE001 - every failure is reported on the protocol line
        detail = str(e) if isinstance(e, ExportFailed) else f"{type(e).__name__}: {e}"
        reply({"ok": False, "code": "EXPORT_FAILED", "detail": redactor(detail)[:DETAIL_MAX]})
        sys.exit(1)
    reply({"ok": True, "games": games})


if __name__ == "__main__":
    main()
