"""Make view-ready splats for viewer/index.html (metres, Z-up, colour only / SH degree 0).

Outputs (data/L1/): view_full.ply (everything), view_noceiling.ply (ceiling, below-floor reflections
and far-outside junk removed, for the top-down view).
Run: .venv/bin/python scripts/make_viewer_splats.py
"""
import json

import numpy as np
from scipy.spatial import cKDTree

from common import L1, read_ply, splat_scale, write_ply


def main():
    g = read_ply(L1 / "splat_clean.ply")
    s = splat_scale()
    xyz = np.stack([g["x"], g["y"], g["z"]], 1) / s
    cols = {"x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2]}
    for k in ["f_dc_0", "f_dc_1", "f_dc_2", "opacity"]:
        cols[k] = g[k]
    for k in ["scale_0", "scale_1", "scale_2"]:
        cols[k] = g[k] - np.log(s)  # log-scale: shrinking size by s = subtracting log(s)
    for k in ["rot_0", "rot_1", "rot_2", "rot_3"]:
        cols[k] = g[k]
    write_ply(L1 / "view_full.ply", cols)

    graph = json.load(open(L1 / "graph_L1.json"))
    floor = np.array([[n["x"], n["y"], n["z"]] for n in graph["nodes"] if n["type"] == "walked"])
    d, i = cKDTree(floor[:, :2]).query(xyz[:, :2])
    h = xyz[:, 2] - floor[i, 2]
    keep = (h > -0.1) & (h < 2.0) & (d < 10.0)
    write_ply(L1 / "view_noceiling.ply", {k: v[keep] for k, v in cols.items()})
    print(f"view_full {len(xyz)}  view_noceiling {keep.sum()}")


if __name__ == "__main__":
    main()
