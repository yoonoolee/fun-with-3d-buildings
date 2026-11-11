"""Shared I/O: splat PLY reading/writing and pano positions in the splat-metre frame."""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
L1 = ROOT / "data" / "L1"
CAM_H = 1.65  # camera height above floor (m)


def read_ply(path):
    raw = open(path, "rb").read()
    h = raw.index(b"end_header\n") + len(b"end_header\n")
    hdr = raw[:h].decode().splitlines()
    props = [l.split()[-1] for l in hdr if l.startswith("property")]
    n = int(next(l for l in hdr if l.startswith("element vertex")).split()[-1])
    a = np.frombuffer(raw[h:], np.float32, count=n * len(props)).reshape(n, len(props))
    return {p: a[:, i] for i, p in enumerate(props)}


def write_ply(path, cols):
    names = list(cols)
    n = len(cols[names[0]])
    hdr = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n
    hdr += "".join("property float %s\n" % k for k in names) + "end_header\n"
    data = np.stack([cols[k].astype(np.float32) for k in names], 1)
    with open(path, "wb") as f:
        f.write(hdr.encode())
        f.write(data.tobytes())


def splat_scale(d=L1):
    return json.load(open(d / "dataparser_transforms.json"))["scale"]


def load_splat_m(d=L1, min_opacity=0.5, max_size_m=1.0):
    """Gaussian centres in metres (Z-up), filtered to opaque, not-huge blobs."""
    g = read_ply(d / "splat_clean.ply")
    s = splat_scale(d)
    xyz = np.stack([g["x"], g["y"], g["z"]], 1) / s
    op = 1 / (1 + np.exp(-g["opacity"]))
    size = np.exp(np.stack([g["scale_0"], g["scale_1"], g["scale_2"]], 1)).max(1) / s
    keep = (op > min_opacity) & (size < max_size_m)
    return xyz[keep]


def panos_in_splat_m(d=L1):
    """Manifest stations and their positions (N,3) in the splat-metre frame. See CLAUDE.md."""
    man = json.load(open(d / "L1_manifest.json"))
    reg = json.load(open(d / "pano_reg.json"))
    P = np.array([s["position"] for s in man["stations"]])
    E = np.stack([P[:, 0], -P[:, 2], P[:, 1]], 1)  # Y-up [x,z,-y] -> Z-up
    th = reg["theta_rad"]
    R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    c = E - np.array(reg["e57_mean"])
    xy = c[:, :2] @ R.T + np.array(reg["t"][:2])
    z = c[:, 2] + reg["t"][2]
    return man, np.column_stack([xy, z])
