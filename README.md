# Fun with 3D Buildings

Indoor navigation for UC Berkeley's **Grimes Engineering Center** (CS 280A final project), built from 360° photos.

**Repo:** https://github.com/yoonoolee/fun-with-3d-buildings

**Pipeline:** 360° photos → Gaussian splat (3D model) → walkable map → **navigation graph** → landmark labels → shortest-path routing.

We're working on **Level 1 only** until the whole pipeline works, and will redo it later for a new building we capture ourselves.

## Status
| Step | Status |
|---|---|
| 3D model (Gaussian splat of L1) | Done |
| Navigation graph | **First version done.** 484 nodes, 509 edges, one connected graph. Stairs and ramps are not modelled yet. |
| Landmark labels (doors, exits, elevators…) | Started; not yet aligned with the graph |
| Routing (A → B, turn-by-turn) | Not started |

## Setup
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
bash scripts/download_data.sh      # needs data/drive_ids.txt — ask a teammate (not in git)
```
The 3D data is large and team-only, so it isn't in this repo. The download script puts it in `data/L1/`.

## Use
**Build the graph** (about 1 min). This writes `data/L1/graph_L1.json`:
```bash
.venv/bin/python scripts/build_graph.py
```

**See the graph inside the 3D model:**
```bash
python3 -m http.server 8765
```
Then open http://localhost:8765/viewer/.
- **Top-down (no ceiling):** drag to rotate, right-drag to pan, scroll to zoom. Click a ball to walk in from there.
- **Walk inside:** drag to look around, **W/A/S/D** or the arrow keys to move, **Shift** to go faster. Click a ball to stand on it; **◀ ▶** steps through the photo spots.
- **Colours:**
  - blue = paths and junctions
  - purple = dead ends
  - orange = photo spots
  - red = edges that change height (stairs or ramps)

## How the graph is made
1. **Floor height:** taken from the camera heights (camera was carried about 1.38 m above the floor).
2. **Top-down map** of 10 cm squares. A square is blocked if the 3D model has stuff 0.3–1.8 m above the floor there.
3. **Walkable space** is space a camera could see, with a ceiling above it, at least 25 cm from obstacles.
4. **Centre lines** of the walkable space become the graph: junctions where routes meet, dead ends, and nodes about every 1.5 m.
5. **Each photo spot** is linked to its nearest graph node.
6. **Automatic checks** are saved in the JSON: one connected graph, no edges through walls, and so on.

**Node types:**
- `junction`: where routes meet
- `path`: points along a route
- `endpoint`: a dead end
- `walked`: a photo spot, with its 360° photo

## Files
```
scripts/common.py              shared helpers: load the 3D model and photo positions in metres
scripts/build_graph.py         builds the navigation graph -> data/L1/graph_L1.json
scripts/make_viewer_splats.py  makes the 3D-model files the viewer loads
scripts/download_data.sh       downloads the data from the team Drive
viewer/index.html              graph-in-3D-model viewer
data/L1/graph_L1.json          the graph (nodes + edges + checks)
data/L1/pano_reg.json          how photo positions line up with the 3D model
CLAUDE.md                      detailed technical notes (coordinate frames, parameters, known issues)
```

## Next
- **Stairs and ramps:** follow the actual step heights and label edges as flat, stairs or ramp, for accessible routing.
- **Routing:** shortest path between two points, with turn-by-turn directions.
- **Labels:** place doors, exits, elevators and similar on the graph.
