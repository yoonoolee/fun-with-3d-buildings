"""Build the L1 navigation graph from the Gaussian splat + pano positions.

Pipeline: local floor height -> occupancy grid -> walkable (eroded) region -> skeleton
-> simplified graph (junctions + nodes every ~1.5 m) -> attach panos -> checks -> JSON.
Run: .venv/bin/python scripts/build_graph.py
Output: data/L1/graph_L1.json
"""
import json

import networkx as nx
import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize

from common import L1, load_splat_m, panos_in_splat_m

# ---- parameters (metres) ----
RES = 0.10            # grid cell size
OBST_LO, OBST_HI = 0.30, 1.80   # obstacle band above local floor
MIN_PTS = 6           # gaussians within a 3x3-cell (30 cm) neighbourhood to count as blocked
CLEARANCE = 0.25      # person half-width: walkable cells must be this far from obstacles
SEEN_RADIUS = 10.0    # only trust space within this distance of a pano
SPUR_LEN = 1.0        # prune dead-end branches shorter than this
SPACING = 1.5         # node spacing along corridors
LONG_EDGE = 3.0       # flag pano->graph links longer than this
FLOOR = 1


def grid_setup(panos):
    lo = panos[:, :2].min(0) - SEEN_RADIUS
    hi = panos[:, :2].max(0) + SEEN_RADIUS
    shape = tuple(np.ceil((hi - lo) / RES).astype(int))
    return lo, shape


def to_ij(xy, lo):
    return np.floor((xy - lo) / RES).astype(int)


def to_xy(ij, lo):
    return lo + (np.asarray(ij) + 0.5) * RES


def pano_floors(xyz, panos):
    """Floor z under each pano: densest horizontal layer 0.7-2.1 m below the camera (ring 0.6-3 m,
    since the nadir under the camera is blurred). Gaps filled along the walk sequence."""
    t = cKDTree(xyz[:, :2])
    rel = np.full(len(panos), np.nan)
    for i, p in enumerate(panos):
        idx = np.array(t.query_ball_point(p[:2], 3.0))
        if len(idx) == 0:
            continue
        q = xyz[idx]
        q = q[np.hypot(*(q[:, :2] - p[:2]).T) > 0.6]
        z = q[:, 2] - p[2]
        h, e = np.histogram(z[(z > -2.1) & (z < -0.7)], bins=np.arange(-2.1, -0.69, 0.05))
        h = np.convolve(h, [1, 2, 1], "same")
        if h.max() >= 40:
            rel[i] = e[h.argmax()] + 0.025
    # Per-pano estimates are noisy (+-0.5 m); the Cupix camera heights are clean and the camera was
    # carried at a ~constant height, so use one robust camera height for all panos.
    cam_h = -np.nanmedian(rel)
    print(f"camera height above floor (median of per-pano estimates): {cam_h:.2f} m")
    return panos[:, 2] - cam_h


def occupancy(xyz, panos, floors, lo, shape):
    tree = cKDTree(panos[:, :2])
    _, near = tree.query(xyz[:, :2])
    h = xyz[:, 2] - floors[near]  # height above local floor
    ij = to_ij(xyz[:, :2], lo)
    inb = (ij >= 0).all(1) & (ij < shape).all(1)

    def count(mask):
        g = np.zeros(shape, np.int32)
        np.add.at(g, tuple(ij[mask & inb].T), 1)
        return g

    obst = ndi.uniform_filter(count((h > OBST_LO) & (h < OBST_HI)).astype(float), 3) * 9
    blocked = obst >= MIN_PTS
    blocked = ndi.binary_closing(blocked, iterations=1)             # close pinholes in walls
    lab, n = ndi.label(blocked)                                      # drop tiny specks (noise)
    sizes = ndi.sum(blocked, lab, range(1, n + 1))
    blocked &= np.isin(lab, 1 + np.flatnonzero(sizes >= 4))

    # indoor = has ceiling above (outside, through glass/gaps, there is only sky)
    ceil = ndi.uniform_filter(count((h > 2.0) & (h < 12.0)).astype(float), 5) * 25 >= 3
    indoor = ndi.binary_fill_holes(ndi.binary_closing(ceil, iterations=5))
    walked = walked_corridor(panos, lo, shape)
    blocked &= ~walked                      # the camera physically passed here
    seen = (visibility(blocked, panos, lo) & indoor) | walked
    return blocked, seen, walked


def walked_corridor(panos, lo, shape, half_width=0.3):
    """Cells along the capture walk (consecutive panos, skipping known route gaps > 5.5 m)."""
    m = np.zeros(shape, bool)
    for a, b in zip(panos[:-1, :2], panos[1:, :2]):
        if np.linalg.norm(b - a) > 5.5:
            continue
        ij = to_ij(np.linspace(a, b, max(2, int(np.linalg.norm(b - a) / (RES / 2)))), lo)
        m[tuple(ij.T)] = True
    return ndi.binary_dilation(m, iterations=int(half_width / RES))


def visibility(blocked, panos, lo, n_rays=1440, step=RES / 2):
    """2D ray casting from each pano: cells a camera could see before hitting an obstacle."""
    seen = np.zeros(blocked.shape, bool)
    ang = np.linspace(0, 2 * np.pi, n_rays, endpoint=False)
    dirs = np.stack([np.cos(ang), np.sin(ang)], 1)
    r = np.arange(0, SEEN_RADIUS, step)
    for p in panos[:, :2]:
        pts = p + dirs[:, None, :] * r[None, :, None]            # rays x steps x 2
        ij = to_ij(pts, lo)
        inb = (ij >= 0).all(-1) & (ij < blocked.shape).all(-1)
        ij = np.where(inb[..., None], ij, 0)
        hit = blocked[ij[..., 0], ij[..., 1]] | ~inb
        first = np.where(hit.any(1), hit.argmax(1), len(r))     # first obstacle along each ray
        ok = np.arange(len(r))[None, :] < first[:, None]
        seen[ij[ok][:, 0], ij[ok][:, 1]] = True
    return ndi.binary_closing(seen, iterations=2) & ~blocked


def walkable_region(blocked, seen, walked, panos, lo):
    clear = ndi.distance_transform_edt(~blocked) * RES
    walk = seen & ~blocked & (clear >= CLEARANCE)
    walk = ndi.binary_opening(walk, iterations=1) | walked          # smooth ragged edges; keep walked path
    lab, _ = ndi.label(walk)
    # keep only components reachable from a pano (snap each pano to nearest walk cell within 1 m)
    wij = np.argwhere(walk)
    t = cKDTree(wij)
    d, k = t.query(to_ij(panos[:, :2], lo))
    seeds = wij[k[d * RES < 1.0]]
    keep = np.unique(lab[tuple(seeds.T)])
    return np.isin(lab, keep[keep > 0]), clear


def skeleton_graph(walk, lo):
    """Pixel skeleton -> NetworkX graph whose nodes are junction/end clusters, edges carry pixel paths."""
    sk = skeletonize(walk)
    nb = ndi.convolve(sk.astype(int), np.ones((3, 3), int), mode="constant") - 1
    deg = np.where(sk, nb, 0)
    nodepix = sk & (deg != 2)
    lab, n = ndi.label(nodepix, structure=np.ones((3, 3)))
    G = nx.Graph()
    for c in range(1, n + 1):
        pts = np.argwhere(lab == c)
        G.add_node(c, ij=pts.mean(0))
    visited = np.zeros_like(sk)
    offs = [(a, b) for a in (-1, 0, 1) for b in (-1, 0, 1) if (a, b) != (0, 0)]
    H, W = sk.shape

    def nbrs(p):
        for a, b in offs:
            q = (p[0] + a, p[1] + b)
            if 0 <= q[0] < H and 0 <= q[1] < W and sk[q]:
                yield q

    def add_edge(u, v, path):
        if u == v and len(path) < 3:
            return
        L = (len(path) + 1) * RES
        if G.has_edge(u, v) and G[u][v]["len"] <= L:
            return
        G.add_edge(u, v, path=path, len=L)

    for p in map(tuple, np.argwhere(nodepix)):
        u = lab[p]
        for q in nbrs(p):
            if lab[q] and lab[q] != u:
                add_edge(u, lab[q], [])
            elif not lab[q] and not visited[q]:
                path, prev, cur = [], p, q
                while True:
                    visited[cur] = True
                    path.append(cur)
                    nxt = [r for r in nbrs(cur) if r != prev]
                    hit = [r for r in nxt if lab[r]]
                    cont = [r for r in nxt if not lab[r] and not visited[r]]
                    if hit:
                        add_edge(u, lab[hit[0]], path)
                        break
                    if not cont:
                        break
                    prev, cur = cur, cont[0]
    for c in G.nodes:
        G.nodes[c]["xy"] = to_xy(G.nodes[c]["ij"], lo)
    return G, sk


def prune_and_contract(G):
    for _ in range(4):  # remove short dead-end spurs
        spurs = [u for u in G.nodes if G.degree(u) == 1 and G[u][next(iter(G[u]))]["len"] < SPUR_LEN]
        if not spurs:
            break
        G.remove_nodes_from(spurs)
    G.remove_nodes_from([u for u in list(G.nodes) if G.degree(u) == 0])
    for u in [u for u in list(G.nodes) if G.degree(u) == 2]:  # merge pass-through nodes
        a, b = list(G[u])
        if a == b or G.has_edge(a, b):
            continue
        pa, pb = G[u][a]["path"], G[u][b]["path"]
        ua = pa if _starts_near(pa, G.nodes[a]["ij"]) else pa[::-1]
        ub = pb if not _starts_near(pb, G.nodes[b]["ij"]) else pb[::-1]
        G.add_edge(a, b, path=ua + [tuple(np.round(G.nodes[u]["ij"]).astype(int))] + ub,
                   len=G[u][a]["len"] + G[u][b]["len"])
        G.remove_node(u)
    return G


def _starts_near(path, ij):
    return bool(path) and np.hypot(*(np.array(path[0]) - ij)) < np.hypot(*(np.array(path[-1]) - ij))


def resample(G, lo, floor_z, blocked):
    """Final graph: junction/end nodes + intermediate nodes every ~SPACING m along each edge."""
    F = nx.Graph()
    name = {}
    for u in G.nodes:
        x, y = G.nodes[u]["xy"]
        kind = "junction" if G.degree(u) >= 3 else "endpoint"
        name[u] = f"f{FLOOR}_{kind[0]}{u}"
        F.add_node(name[u], x=float(x), y=float(y), z=floor_z(x, y), type=kind, source="skeleton")
    for k, (u, v, d) in enumerate(G.edges(data=True)):
        a, b = G.nodes[u]["ij"], G.nodes[v]["ij"]
        path = d["path"] if _starts_near(d["path"], a) else d["path"][::-1]
        pts = np.vstack([a, np.array(path, float).reshape(-1, 2), b])
        seg = np.hypot(*np.diff(pts, axis=0).T) * RES
        cum = np.concatenate([[0], np.cumsum(seg)])
        # fewest evenly spaced nodes (>= length/SPACING) whose straight chords stay off obstacles
        for nseg in range(max(1, int(round(cum[-1] / SPACING))), len(pts)):
            idx = [0] + [min(int(np.searchsorted(cum, s * cum[-1] / nseg)), len(pts) - 1) for s in range(1, nseg)] + [len(pts) - 1]
            xy = to_xy(pts[idx], lo)
            if all(line_clear(xy[m], xy[m + 1], blocked, lo) for m in range(len(xy) - 1)):
                break
        prev = name[u]
        for s in range(1, nseg):
            x, y = xy[s]
            nid = f"f{FLOOR}_p{k}_{s}"
            F.add_node(nid, x=float(x), y=float(y), z=floor_z(x, y), type="path", source="skeleton")
            F.add_edge(prev, nid)
            prev = nid
        F.add_edge(prev, name[v])
    for a, b in F.edges:
        F[a][b].update(type="walk", dist_m=float(np.hypot(F.nodes[a]["x"] - F.nodes[b]["x"], F.nodes[a]["y"] - F.nodes[b]["y"])))
    return F


def line_clear(p, q, blocked, lo):
    n = max(2, int(np.hypot(*(q - p)) / (RES / 2)))
    ij = to_ij(np.linspace(p, q, n), lo)
    ij = np.clip(ij, 0, np.array(blocked.shape) - 1)
    return not blocked[tuple(ij.T)].any()


def attach_panos(F, man, panos, floors, blocked, lo):
    ids = [u for u in F.nodes]
    xy = np.array([[F.nodes[u]["x"], F.nodes[u]["y"]] for u in ids])
    t = cKDTree(xy)
    unattached = []
    for s, p, fz in zip(man["stations"], panos, floors):
        pid = "pano_%03d" % int(s["file"].split(".")[0])
        F.add_node(pid, x=float(p[0]), y=float(p[1]), z=float(fz), type="walked",
                   image=s["file"], station=s["id"], source="manifest")
        d, k = t.query(p[:2], k=8)
        for dd, kk in zip(d, k):
            if line_clear(p[:2], xy[kk], blocked, lo):
                F.add_edge(pid, ids[kk], type="walk", dist_m=float(dd), verified=True)
                break
        else:
            unattached.append(pid)
    return unattached


def checks(F, man, blocked, lo):
    rep = {"components": [len(c) for c in sorted(nx.connected_components(F), key=len, reverse=True)]}
    xy = lambda u: np.array([F.nodes[u]["x"], F.nodes[u]["y"]])  # noqa: E731
    rep["edges_through_walls"] = [(a, b) for a, b in F.edges if not line_clear(xy(a), xy(b), blocked, lo)]
    rep["long_pano_links"] = [(a, b, round(d["dist_m"], 2)) for a, b, d in F.edges(data=True)
                              if (a.startswith("pano") or b.startswith("pano")) and d["dist_m"] > LONG_EDGE]
    bad = []
    for i, s in enumerate(man["stations"]):
        for j in s["neighbors"]:
            if j <= i:
                continue
            a, b = "pano_%03d" % i, "pano_%03d" % j
            e = np.linalg.norm(xy(a) - xy(b))
            try:
                g = nx.shortest_path_length(F, a, b, weight="dist_m")
            except nx.NetworkXNoPath:
                g = float("inf")
            if g > 2.0 * e + 1.0:
                bad.append((a, b, round(e, 2), round(g, 2)))
    rep["neighbor_detours"] = bad
    return rep


def main():
    man, panos = panos_in_splat_m()
    xyz = load_splat_m()
    lo, shape = grid_setup(panos)
    floors = pano_floors(xyz, panos)
    blocked, seen, walked = occupancy(xyz, panos, floors, lo, shape)
    walk, clear = walkable_region(blocked, seen, walked, panos, lo)
    G, sk = skeleton_graph(walk, lo)
    G = prune_and_contract(G)

    ptree = cKDTree(panos[:, :2])
    def floor_z(x, y):
        return float(floors[ptree.query([x, y])[1]])

    F = resample(G, lo, floor_z, blocked)
    unattached = attach_panos(F, man, panos, floors, blocked, lo)
    rep = checks(F, man, blocked, lo)
    rep["unattached_panos"] = unattached

    nodes = [{"id": u, "floor": FLOOR, **{k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()}}
             for u, d in F.nodes(data=True)]
    edges = [{"from": a, "to": b, **{k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()}}
             for a, b, d in F.edges(data=True)]
    for e in edges:
        e.setdefault("verified", False)
    json.dump({"frame": "splat-metre, Z-up (see CLAUDE.md)", "nodes": nodes, "edges": edges, "checks": rep},
              open(L1 / "graph_L1.json", "w"), indent=1)

    print(f"nodes {F.number_of_nodes()}  edges {F.number_of_edges()}  components {rep['components']}")
    print(f"edges through walls {len(rep['edges_through_walls'])}  long pano links {len(rep['long_pano_links'])}  "
          f"neighbor detours {len(rep['neighbor_detours'])}  unattached panos {len(unattached)}")
    for k in ["long_pano_links", "neighbor_detours", "unattached_panos"]:
        if rep[k]:
            print(k, rep[k][:12])


if __name__ == "__main__":
    main()
