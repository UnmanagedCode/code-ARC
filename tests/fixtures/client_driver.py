"""Drives clients/code_arc.py against a test backend; prints one JSON line.

argv: <clients dir> <base_url> <token> <scenario>
"""

import json
import sys

sys.path.insert(0, sys.argv[1])
from code_arc import Refusal, Session  # noqa: E402

base, token, scenario = sys.argv[2], sys.argv[3], sys.argv[4]
out = {}
if scenario == "grid":
    s = Session.attach(base, token, "read the grid as ints")
    obs = s.act("ACTION4", reasoning="move right")
    out = {"step": obs.step, "run": s.run, "grid": obs.grid, "available": obs.available_actions}
elif scenario == "refusals":
    s = Session.attach(base, token, "probe refusals")
    try:
        s.act("ACTION5")
    except Refusal as e:
        out["unavailable"] = {"code": e.code, "available_actions": e.extra.get("available_actions")}
    stale = Session(base, token)
    stale.run = s.run + 1
    try:
        stale.act("ACTION1")
    except Refusal as e:
        out["stale"] = e.code
elif scenario == "no_run":
    s = Session(base, token)
    s.run = 1
    try:
        s.act("ACTION1")
    except Refusal as e:
        out["code"] = e.code
elif scenario == "rate":
    s = Session.attach(base, token, "burst until refused")
    acts = 0
    for _ in range(1000):
        try:
            s.act("ACTION1")
            acts += 1
        except Refusal as e:
            out = {"acts": acts, "code": e.code, "retry_after_ms": e.retry_after_ms}
            break
print(json.dumps(out))
