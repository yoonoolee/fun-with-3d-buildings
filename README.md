# Fun with 3D Buildings

Grimes (Level 1) from 360° photos → Gaussian splat.

- `navigation/`: navigation graph + viewer. Live: https://yoonoolee.github.io/fun-with-3d-buildings/
- `graffiti/`: draw on the walls of the 3D model.

## Setup
```bash
python3 -m venv .venv && .venv/bin/pip install -r navigation/requirements.txt
bash navigation/scripts/download_data.sh   # needs navigation/data/drive_ids.txt (ask a teammate)
```

## Navigation
```bash
.venv/bin/python navigation/scripts/build_graph.py   # -> navigation/data/L1/graph_L1.json
python3 -m http.server 8765                          # then open http://localhost:8765/navigation/viewer/
```

## Graffiti
Run `python3 graffiti/serve.py`. See `graffiti/README.txt`.
