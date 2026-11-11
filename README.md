# Fun with 3D Buildings

Indoor navigation graph for Grimes (Level 1), built from a Gaussian splat of 360° photos.

## Setup
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
bash scripts/download_data.sh   # needs data/drive_ids.txt (ask a teammate)
```

## Use
```bash
.venv/bin/python scripts/build_graph.py   # -> data/L1/graph_L1.json
python3 -m http.server 8765               # then open http://localhost:8765/viewer/
```

Technical notes are in `CLAUDE.md`.
