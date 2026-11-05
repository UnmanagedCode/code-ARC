"""Renders board images with clients/code_arc.py's Observation.save_png.

argv: <clients dir> <out dir>
stdin: JSON [{rows, scale, grid, out}]; prints the JSON list of written paths.
"""

import json
import os
import sys

sys.path.insert(0, sys.argv[1])
from code_arc import Observation  # noqa: E402

out_dir = sys.argv[2]
paths = []
for case in json.load(sys.stdin):
    obs = Observation({"frame": case["rows"]})
    paths.append(obs.save_png(os.path.join(out_dir, case["out"]), scale=case["scale"], grid=case["grid"]))
print(json.dumps(paths))
