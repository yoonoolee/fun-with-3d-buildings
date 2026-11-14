# Grimes Indoor Navigation (CS 280A final project)

Indoor navigation for UC Berkeley's Grimes Engineering Center from 360° panoramas:
**3D reconstruction → walkable map → navigation graph → landmark labels → shortest-path routing.**
Work on **Level 1 (L1) only** until the whole pipeline works end to end.

## Status (2026-11-10)
| Step | Status | Owner |
|---|---|---|
| 1. Capture | Done (Cupix scan, Oct 18). | — |
| 2. Reconstruction | Done for L1: Gaussian splat. | Teammate |
| 3. Graph creation | **First version done:** `navigation/scripts/build_graph.py` → `navigation/data/L1/graph_L1.json`. Needs human review; stairs not modelled yet. | Us |
| 4. Labeling | Started: VLM-verified L1 objects exist, but in the Metashape floorplan frame. | Teammate |
| 5. Routing | Not started. | — |
| 6. Showcase | Undecided: 3D sim / game / AR. | — |

## Data (team Google Drive; IDs are NOT in git)
- Drive folder and file IDs live only in the untracked `navigation/data/drive_ids.txt`.
- `bash navigation/scripts/download_data.sh` downloads the files into `navigation/data/L1/` and builds the viewer splats.

| What | Drive path |
|---|---|
| **Splat (use this)** | `Gaussian Splatting - Grimes L1/export/splat_clean.ply` (100 MB) |
| Splat scale/transform | `.../dataparser_transforms.json` |
| L1 pano manifest | `Grimes_360_Oct18/L1/panoramas/manifest.json` |
| Floater scores | `.../floater_scores.npz` (means, opacity, n_vis, cam_dist_m) |
| Panos | `Grimes_360_Oct18/L{1,2,3}/panoramas/*.jpg` (100 / 54 / 54) |

Other Drive contents:
- **Ignore:** the Metashape outputs. They were worse than the splat.
- **Reference only:** the VLM labels (`vlm/`) and the splat videos (`renders/*.mp4`).

**Facts about the data:**
- The panos are 4096×2048 equirectangular images; the `mobile/` copies are 2048×1024.
- Faces are blurred. Do not republish the photos.
- **Camera positions are already known** (Cupix, in metres). No structure-from-motion is needed.
- Manifest `stations[i]` has these fields:
  - `position`: Y-up, stored as `[x, z, -y]`
  - `e57Quaternion`
  - `neighbors`: consecutive walk frames (≤5.5 m apart)
- Manifest `routeGaps` lists two gaps in the walk: 87→88 (11.5 m, 0.8 m height change) and 98→99.
- The splat was trained with nerfstudio `splatfacto` on the teammate's Windows/CUDA machine. The PLY is Z-up and contains no camera poses.
- `walk_path*.json` is a hand-made video fly-through path, **not** the capture poses.

## Coordinate frames
All graph work happens in the **splat-metre frame**. Formulas:
```
splat_m = ply_xyz / 0.03147103158196005             # ≈ metres (verified: floor ≈ 1.7 m below cameras)
e57     = (pos[0], -pos[2], pos[1])                 # manifest Y-up -> Z-up
xy      = R(0.0104720 rad) @ (e57_xy - [20.40966, -18.62210]) + [0.05966, 0.67790]
z       = (e57_z - 6.27473) - 0.65
```
- The pano→splat transform was fitted by us: each pano should sit in free space with a floor about 1.6 m below it. It was checked visually, not surveyed.
- `Grimes_360_Oct18/registration.json` maps the scan frame to the BIM frame. It is provisional.

**Geometry facts:**
- L1 is **not flat**. The west and east halves differ by about 0.8 m, and the auditorium is tiered. Use a per-region floor height, not one plane.
- The floor is sparse in the splat (shiny/low-texture surfaces). There is a reflection layer about 0.5 m below the real floor.
- The obstacle slice (0.3–1.8 m above the floor) shows walls clearly.

## Graph builder: how it actually works (`.venv/bin/python navigation/scripts/build_graph.py`, ~1 min)
The original plan below was adjusted as follows:
1. **Floor height under each photo spot.** Floor = Cupix camera z − 1.38 m. The 1.38 m is the median of per-photo measurements from the splat (densest layer 0.7–2.1 m below the camera, in a ring 0.6–3 m out). The per-photo measurements are noisy (±0.5 m), so they aren't used individually.
   - Cupix heights show L1 is **split-level**: a lower part (camera z ≈ −1.1) and an upper part (≈ −0.3), about 0.8 m apart, plus the tiered auditorium.
   - Steps between the two parts appear at photos 71→72 (entrance lobby), 85→86 (west, by the auditorium doors), and 35→36 (auditorium east door; possibly with a ramp).
   - The atrium staircase goes up to L2 (photo 50). A staircase down and 2 elevators are at photo 71.
   - **Stairs and ramps are not labelled in the graph yet.**
2. **Blocked cells.** At least 6 Gaussians at 0.3–1.8 m above the local floor within a 30 cm neighbourhood. Wall blobs are sparse, so a per-cell count misses walls.
3. **Seen cells.** Found by 2D ray casting from each photo spot, kept only where there is a ceiling above (this stops leaks through glass). The walked path between consecutive photos is carved in as always walkable.
4. **Walkable.** At least 25 cm clearance from obstacles. Then: skeleton → own pixel tracer (no `sknw`) → prune spurs shorter than 1 m → nodes every ~1.5 m, with extra nodes wherever a chord would cross an obstacle.
5. **Photo spots.** Each is linked to its nearest graph node with line of sight.
   - Direct photo-to-photo walk edges were removed by request (2026-11-10).
   - The walked path is still carved into the walkable map.
6. **Checks** (stored in the JSON under `checks`): components, edges through walls, long photo links, detours between neighbouring photos, unattached photos.

Current result: 484 nodes, 509 edges, 1 component, 0 edges through walls. 7 pairs of neighbouring photos connect only via a detour (2–4× the straight distance) and should be reviewed.

**Known issues to review:**
- Small leaks at the far left (x≈−21, y≈−8) and bottom-left (x≈−17, y≈−20).
- A strip at x 13–20, y 2–7 that may be a real space or a leak.
- Auditorium seat rows are treated as walls.
- No floor-change links yet (only L1 exists).


## Original plan: graph creation (L1)
1. **Load the splat.** Read the PLY, convert to metres, and keep Gaussians with `sigmoid(opacity) > 0.5`.
2. **Load the panos.** Read the manifest and apply the transform above.
3. **Floor height map.** Floor ≈ pano z − ~1.65 m. Interpolate over the map, or take the floor from the splat near each pano.
4. **Occupancy grid** (10 cm cells):
   - **Blocked:** ≥3 Gaussians between 0.3 and 1.8 m above the local floor.
   - **Free:** inside the area reached by the panos/walk.
   - **Unknown:** treated as blocked.
   - Then erode free space by about 30 cm.
5. **Skeletonize.** Run `skimage.skeletonize` → `sknw` → NetworkX, and simplify to nodes every 1–2 m plus junctions and endpoints.
6. **Attach panos.** Link each pano to its nearest graph node, which keeps its image for localization.
7. **Checks:**
   - Disconnected components.
   - Edges crossing blocked cells.
   - Long edges.
   - Manifest `neighbors` pairs that are not connected in the graph.
   - The known gaps (87→88, 98→99).
   - Glass walls and auditorium seat rows.
8. **Visualize** the graph, then export the graph JSON (format below).

## Later steps
- **Labeling.**
  - Re-project the teammate's VLM objects into the splat frame. Alternatively, rerun detection: perspective crops (`py360convert`) → open-vocabulary detector + OCR. Use a VLM only to verify detections, never for localization.
  - Merge detections within about 1 m.
  - Attach each POI to its nearest node.
  - Stairs/elevators at the same x,y on different floors get vertical edges.
- **Routing.**
  - Dijkstra with edge cost in seconds: walking = dist/1.4 m/s, stairs ≈ 20 s per floor, elevator ≈ 45 s.
  - Accessible mode removes stairs.
  - Directions: a turn when heading changes >30°, a U-turn when >150°.
  - An LLM may phrase the directions but never computes routes.
- **Other floors.** L2 and L3 have panos but no splat yet.

## Graph JSON format
Edges are undirected unless `"directed": true`. `id` is generated automatically; `name` is a display field only.
```json
{"nodes":[{"id":"pano_041","floor":1,"x":12.4,"y":7.1,"z":-1.7,"type":"walked","image":"00041.jpg"},
          {"id":"f1_j3","floor":1,"x":15.6,"y":7.1,"z":-1.7,"type":"junction","source":"skeleton"},
          {"id":"elev_A_f1","floor":1,"x":21.0,"y":6.8,"z":-1.7,"type":"elevator","shaft":"A"},
          {"id":"poi_microwave_f1_1","floor":1,"x":9.3,"y":4.1,"z":-1.7,"type":"poi","label":"microwave","near_node":"f1_j3"}],
 "edges":[{"from":"pano_041","to":"f1_j3","type":"walk","dist_m":3.2,"verified":true},
          {"from":"elev_A_f1","to":"elev_A_f2","type":"elevator","cost_s":45}]}
```

## Repo layout
- `navigation/`: our graph pipeline and viewer (everything below).
- `graffiti/`: the teammate's "Grimes Graffiti" app, for painting on the walls of the splat. Run it with `python3 graffiti/serve.py`.
  - Works in the **BIM frame** (metres, Z up). `graffiti/data/scene.json` holds the splat→BIM transform and 96 training camera stations.
  - BIM = R·(ply_xyz·31.7753) + (−14.795, 6.098, 6.895), i.e. the inverse of `dataparser_transforms.json`.
  - Our fitted pano positions agree with its stations to 0.23 m median in xy; ours are 0.66 m too low in z.
  - Data in git: `splat.ply` and `mesh_pos.bin`/`mesh_idx.bin` (decimated Metashape mesh, in BIM).

## Project files
GitHub repo: https://github.com/yoonoolee/fun-with-3d-buildings (public). Keep Drive IDs, photos, and `.ply` files out of it.
- `navigation/data/L1/`:
  - In git: `pano_reg.json` (our pano→splat transform), `graph_L1.json` (graph output).
  - Site: https://yoonoolee.github.io/fun-with-3d-buildings/ (root `index.html` redirects to `navigation/viewer/`).
  - Local only, gitignored:
    - from Drive: `splat_clean.ply`, `dataparser_transforms.json`, `L1_manifest.json`
  - Hosted publicly (committed for GitHub Pages; user decided 2026-11-10): `view_full.ply`, `view_noceiling.ply`. Regenerate them with `make_viewer_splats.py` and commit after changes.
- `navigation/scripts/common.py`: PLY I/O, `load_splat_m()`, `panos_in_splat_m()`.
- `navigation/scripts/build_graph.py`: the graph builder.
- `navigation/scripts/make_viewer_splats.py`: makes the viewer splats.
- `navigation/scripts/download_data.sh`: fetches the data from Drive.
- `navigation/viewer/index.html`: shows the graph (3D tubes and balls) inside the splat.
  - Uses three.js + gaussian-splats-3d 0.4.7 from CDN.
  - Run `python3 -m http.server 8765` from the repo root, then open `http://localhost:8765/navigation/viewer/` (`?mode=top`, or `?mode=walk&pano=N`).
  - Walk mode has its own first-person controls.
- The Plotly 3D view and the PNG output were removed (2026-11-10). The viewer replaces them.

## Next: stairs (agreed approach, not built yet)
1. Make a per-cell walkable-surface height map from the splat, and measure obstacles relative to it, so step treads stop counting as walls.
2. Classify edges as flat / stairs / ramp from their height profile.
3. Add a small hand-made `annotations_L1.json` for L1's ~4 flights of steps, the possible ramp (photos 35/36), 2 elevators, and the stairs up and down to other floors.

## Environment
- Use the project venv: `.venv/bin/python` (installed from `requirements.txt`: numpy, scipy, networkx, scikit-image).
