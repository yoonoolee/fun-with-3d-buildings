#!/usr/bin/env bash
# Download the L1 input data from the team Google Drive into data/L1/, then build the viewer splats.
# Needs data/drive_ids.txt (not in git; ask a teammate for it). Usage: bash scripts/download_data.sh
set -euo pipefail
cd "$(dirname "$0")/.."
IDS=data/drive_ids.txt
[ -f "$IDS" ] || { echo "Missing $IDS - ask a teammate for it."; exit 1; }
mkdir -p data/L1
grep -v '^#' "$IDS" | while read -r name id; do
  [ -n "${name:-}" ] || continue
  if [ -f "data/L1/$name" ]; then echo "have $name"; continue; fi
  echo "downloading $name"
  curl -sfL -o "data/L1/$name" "https://drive.usercontent.google.com/download?id=$id&export=download&confirm=t"
done
../.venv/bin/python scripts/make_viewer_splats.py
