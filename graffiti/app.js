// 3D graffiti on the Gaussian-splat model of the building.
// Everything is in the BIM frame (metres, Z up). The decimated Metashape mesh is drawn invisibly: it is what
// strokes stick to, and it writes depth so strokes behind walls are hidden.
import * as THREE from 'three';
import * as GS from '@mkkellogg/gaussian-splats-3d';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { firebaseConfig } from './firebase-config.js';
import { connectLive } from './live.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let statusMsg = '';
const setStatus = (t) => { statusMsg = t; };

// ---- identity (only the browser that drew a stroke can delete it)
let owner = store.get('graffitiOwner');
if (!owner) {
  owner = crypto.randomUUID ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  store.set('graffitiOwner', owner);
}
$('author').value = store.get('graffitiAuthor') || '';
$('author').addEventListener('change', () => store.set('graffitiAuthor', $('author').value));
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'X-Owner': owner, 'Content-Type': 'application/json', ...(opts.headers || {}) } });

// ---- where strokes are kept
// 'server': the local Python server (shared by everyone connected to it, photo localisation available)
// 'browser': offline package served by any static file server; strokes live in this browser's storage
//            and can be exported / imported as JSON files to swap drawings between people
const serverBackend = {
  name: 'server',
  async list() {
    const r = await api('api/strokes');
    if (!r.ok) throw new Error(r.status);
    return r.json();
  },
  async add(s) {
    const r = await api('api/strokes', { method: 'POST', body: JSON.stringify(s) });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()).id;
  },
  async remove(id) { return (await api(`api/strokes/${id}`, { method: 'DELETE' })).ok; },
};
const LS_STROKES = 'graffitiStrokes';
let memStrokes = [];
try { memStrokes = JSON.parse(store.get(LS_STROKES) || '[]'); } catch { memStrokes = []; }
const persist = () => store.set(LS_STROKES, JSON.stringify(memStrokes));
const browserBackend = {
  name: 'browser',
  async list() { return memStrokes.map((s) => ({ ...s, mine: true })); },
  async add(s) {
    const id = memStrokes.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    memStrokes.push({ ...s, id });
    persist();
    return id;
  },
  async remove(id) {
    memStrokes = memStrokes.filter((s) => s.id !== id);
    persist();
    return true;
  },
};
// 'live': Firebase (firebase-config.js), shared in real time by everyone on the website; ?emulator uses a local
//         Firebase emulator for testing
let backend = browserBackend;
let live = null;
const emulator = new URLSearchParams(location.search).has('emulator');
const liveConfig = emulator
  ? { apiKey: 'demo-key', projectId: 'demo-graffiti', databaseURL: 'https://demo-graffiti-default-rtdb.firebaseio.com' }
  : firebaseConfig;
if (liveConfig) {
  try {
    live = await connectLive(liveConfig, { emulator });
    backend = live.backend;
  } catch (e) {
    console.error(e);
    setStatus('! Multiplayer unavailable: drawings stay in this browser');
  }
} else {
  try {
    const r = await api('api/strokes');
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) backend = serverBackend;
  } catch { /* no server: offline package */ }
}

// ---- renderer / camera
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); // splat rendering is fill-rate bound: 1.5x on Retina drops to ~40 fps, 1x holds 60
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x111111, 1);
stage.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 300);
camera.up.set(0, 0, 1);
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const cam = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
function forward3() {
  const c = Math.cos(cam.pitch);
  return new THREE.Vector3(c * Math.cos(cam.yaw), c * Math.sin(cam.yaw), Math.sin(cam.pitch));
}
function applyCamera() {
  camera.position.copy(cam.pos);
  camera.lookAt(cam.pos.clone().add(forward3()));
}

const scene = await (await fetch('data/scene.json')).json();

// ---- stations (start points)
const sel = $('station');
for (const s of scene.stations) sel.add(new Option(s.id, s.id));
function goStation(id) {
  const s = scene.stations.find((x) => x.id === id) || scene.stations[0];
  cam.pos.set(...s.xyz);
  cam.yaw = s.yaw;
  cam.pitch = 0;
  sel.value = s.id;
}
sel.addEventListener('change', () => { goStation(sel.value); sel.blur(); });
goStation(store.get('graffitiStation') || scene.stations[0].id);
sel.addEventListener('change', () => store.set('graffitiStation', sel.value));

// ---- overlay scene: invisible mesh (depth + picking), strokes
const overlay = new THREE.Scene();
let occ = null;
let meshViz = null;
let meshReady = false; // strokes are laid onto the mesh, so they are built once it has loaded
let triAdj = null; // vertex -> triangles touching it, to spread paint only across connected surface
function buildAdjacency(geom) {
  const idx = geom.index.array;
  const nv = geom.attributes.position.count;
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const tris = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) tris[fill[idx[i]]++] = (i / 3) | 0;
  triAdj = { start, tris, seen: new Uint32Array(idx.length / 3), stamp: 0 };
}
(async () => {
  const [pos, idx] = await Promise.all(['data/mesh_pos.bin', 'data/mesh_idx.bin']
    .map((u) => fetch(u).then((r) => r.arrayBuffer())));
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  geom.computeVertexNormals();
  geom.computeBoundsTree();
  buildAdjacency(geom);
  occ = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
  }));
  occ.renderOrder = -1;
  overlay.add(occ);
  meshViz = new THREE.Mesh(geom, new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
  meshViz.raycast = () => {};
  meshViz.visible = $('showMesh').checked;
  overlay.add(meshViz);
  meshReady = true;
  for (const e of strokes.values()) if (!e.obj) buildStroke(e);
})();
$('showMesh').addEventListener('change', () => { if (meshViz) meshViz.visible = $('showMesh').checked; });

// ---- splats
const viewer = new GS.Viewer({
  selfDrivenMode: false, renderer, camera, rootElement: stage, useBuiltInControls: false,
  sharedMemoryForWorkers: false, antialiased: true, sphericalHarmonicsDegree: 0, integerBasedSort: false,
});
const t = scene.splat_transform;
viewer.addSplatScene(scene.splat_url || 'data/splat.ply', {
  format: GS.SceneFormat.Ply, position: t.position, rotation: t.quaternion_xyzw, scale: [t.scale, t.scale, t.scale],
  splatAlphaRemovalThreshold: 5, showLoadingUI: true, progressiveLoad: false,
}).then(() => { $('loading').remove(); })
  .catch((e) => { $('loading').textContent = 'Failed to load the model: ' + e; console.error(e); });

// ---- strokes
const strokes = new Map(); // id -> {obj, data}
let myIds = [];
function buildStroke(e, P) {
  const s = e.data;
  try {
    e.obj = newPaint();
    paintFrom(e.obj, P || surfacePoints(s.points), s.width, s.color, 0);
  } catch (err) {
    console.error('bad stroke', s.id, err);
  }
}
function addStroke(s, P) {
  if (strokes.has(s.id)) return;
  const e = { obj: null, data: s };
  strokes.set(s.id, e);
  if (meshReady) buildStroke(e, P);
}
function removeStroke(id) {
  const e = strokes.get(id);
  if (!e) return;
  if (e.obj) dropPaint(e.obj);
  strokes.delete(id);
}
async function sync() {
  try {
    const list = await backend.list();
    const seen = new Set();
    for (const s of list) { seen.add(s.id); addStroke(s); }
    for (const id of [...strokes.keys()]) if (!seen.has(id)) removeStroke(id);
    myIds = list.filter((s) => s.mine).map((s) => s.id);
    if (!statusMsg.startsWith('!') || statusMsg === '! Cannot reach the server') setStatus(`${strokes.size} strokes`);
  } catch (e) {
    setStatus('! Cannot reach the server');
  }
}
if (live) {
  live.onStrokes(
    (s) => {
      addStroke(s);
      if (s.mine && !myIds.includes(s.id)) myIds.push(s.id);
      if (!statusMsg.startsWith('!')) setStatus(`${strokes.size} strokes`);
    },
    (id) => {
      removeStroke(id);
      myIds = myIds.filter((x) => x !== id);
      if (!statusMsg.startsWith('!')) setStatus(`${strokes.size} strokes`);
    },
  );
} else {
  sync();
  if (backend === serverBackend) setInterval(sync, 3000);
}

// ---- other players (multiplayer): their stroke shows live while they draw it
const players = new Map(); // player id -> {paint}
function upsertPlayer(pid, v) {
  removePlayer(pid);
  const d = v.drawing;
  if (!meshReady || !d || !Array.isArray(d.points) || !d.points.length || !/^#[0-9a-fA-F]{6}$/.test(v.color)) return;
  const w = THREE.MathUtils.clamp(Number(d.width) || 0.04, 0.005, 0.3);
  const paint = newPaint();
  paintFrom(paint, surfacePoints(d.points), w, v.color, 0);
  players.set(pid, { paint });
}
function removePlayer(pid) {
  const p = players.get(pid);
  if (!p) return;
  dropPaint(p.paint);
  players.delete(pid);
}
if (live) live.onPlayers(upsertPlayer, removePlayer);

// send my stroke while I draw it, about 10 times a second, only when it changed
let lastSent = 0;
let lastSig = '';
function sendMe(now) {
  if (!live || now - lastSent < 100) return;
  const drawing = cur ? { width: cur.width, points: storedPoints(cur.P.slice(-400), cur.N.slice(-400)) } : null;
  const sig = JSON.stringify([$('color').value, drawing ? drawing.points.length : -1]);
  if (sig === lastSig) return;
  lastSig = sig;
  lastSent = now;
  live.setMe({ color: $('color').value, drawing });
}

const dragOf = new Map(); // stroke id -> drag number: a drag that jumps between surfaces makes several strokes
let undoing = false;
async function undo() {
  if (undoing) return;
  const last = myIds[myIds.length - 1];
  if (last === undefined) { setStatus('Nothing to undo'); return; }
  const g = dragOf.get(last);
  const ids = g === undefined ? [last] : myIds.filter((id) => dragOf.get(id) === g);
  undoing = true;
  let failed = 0;
  for (const id of ids) {
    if (await backend.remove(id)) {
      removeStroke(id);
      myIds = myIds.filter((x) => x !== id); // (the live listener may already have done this)
    } else failed++;
  }
  undoing = false;
  setStatus(failed ? '! Undo failed' : `${strokes.size} strokes`);
}
$('undo').addEventListener('click', undo);

async function clearMine() {
  if (undoing) return;
  const ids = [...myIds];
  if (!ids.length) { setStatus('You have no strokes to clear'); return; }
  if (!confirm(`Delete all ${ids.length} of your strokes? This can't be undone.`)) return;
  undoing = true;
  const ok = await Promise.all(ids.map(async (id) => {
    if (!(await backend.remove(id))) return false;
    removeStroke(id);
    myIds = myIds.filter((x) => x !== id);
    return true;
  }));
  undoing = false;
  const failed = ok.filter((x) => !x).length;
  setStatus(failed ? `! ${failed} strokes could not be deleted` : `${strokes.size} strokes`);
}
$('clearMine').addEventListener('click', clearMine);

// ---- export / import drawings as a JSON file (to swap drawings between people)
$('exportBtn').addEventListener('click', () => {
  const data = [...strokes.values()].map(({ data: s }) => ({
    author: s.author, color: s.color, width: s.width, points: s.points,
  }));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ format: 'grimes-graffiti/1', strokes: data })], { type: 'application/json' }));
  const who = ($('author').value.trim() || 'drawings').replace(/[^\w-]+/g, '_');
  a.download = `graffiti_${who}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  let added = 0;
  try {
    const j = JSON.parse(await file.text());
    const have = new Set([...strokes.values()].map(({ data: s }) => JSON.stringify(s.points)));
    for (const s of j.strokes || []) {
      const ok = Array.isArray(s.points) && s.points.length >= 1 && s.points.length <= MAX_PTS
        && s.points.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))
        && /^#[0-9a-fA-F]{6}$/.test(s.color) && s.width >= 0.005 && s.width <= 0.3;
      if (!ok || have.has(JSON.stringify(s.points))) continue; // skip invalid and already-present strokes
      const st = { author: String(s.author || '').slice(0, 40), color: s.color, width: s.width, points: s.points };
      st.id = await backend.add(st);
      have.add(JSON.stringify(s.points));
      added++;
    }
    if (!live) await sync();
    setStatus(`! Imported ${added} strokes`);
  } catch (e) {
    setStatus('! Not a graffiti file');
    console.error(e);
  }
});

// ---- modes
let mode = 'look';
function setMode(m) {
  mode = m;
  $('modeLook').classList.toggle('on', m === 'look');
  $('modeDraw').classList.toggle('on', m === 'draw');
  $('cursor').style.display = m === 'draw' ? 'block' : 'none';
  canvas.style.cursor = m === 'draw' ? 'none' : 'grab';
}
$('modeLook').addEventListener('click', () => setMode('look'));
$('modeDraw').addEventListener('click', () => setMode('draw'));
setMode('look');
$('width').addEventListener('input', () => { $('widthVal').textContent = `${$('width').value} cm`; });

// ---- picking and the surface under a stroke
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const ndc = new THREE.Vector2();
const MAX_DRAW_M = 60;
const STORE_LIFT = 0.003; // stored points sit 3 mm in front of the surface, which records which side was painted
const brushWidth = () => $('width').value / 100;
const normalRadius = (w) => Math.max(0.04, w * 0.6); // average the bumpy mesh over about the brush size
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
// area-weighted mean normal of the mesh triangles within R of center, each flipped to agree with ref
function surfaceNormal(center, ref, R) {
  const sum = new THREE.Vector3();
  occ.geometry.boundsTree.shapecast({
    intersectsBounds: (box) => box.distanceToPoint(center) <= R,
    intersectsTriangle: (tri) => {
      tri.closestPointToPoint(center, _c);
      if (_c.distanceToSquared(center) > R * R) return false;
      tri.getNormal(_n);
      const a = tri.getArea();
      sum.addScaledVector(_n, _n.dot(ref) < 0 ? -a : a);
      return false;
    },
  });
  return sum.lengthSq() > 1e-12 ? sum.normalize() : ref.clone().normalize();
}
function pickAt(x, y) {
  if (!meshReady) return null;
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const h = raycaster.intersectObject(occ, false)[0];
  if (!h || h.distance > MAX_DRAW_M) return null;
  const ref = h.face.normal.clone();
  if (ref.dot(raycaster.ray.direction) > 0) ref.negate(); // towards the camera
  return { point: h.point.clone(), face: h.faceIndex, dist: h.distance, normal: surfaceNormal(h.point, ref, normalRadius(brushWidth())) };
}
// stored stroke points -> the nearest points on the mesh and their triangles (any stroke, old or new, anyone's)
function surfacePoints(points) {
  const bvh = occ.geometry.boundsTree;
  const P = [];
  const F = [];
  for (const q of points) {
    const p = new THREE.Vector3(...q);
    const hit = bvh.closestPointToPoint(p, { point: new THREE.Vector3() }, 0, 0.2);
    P.push(hit ? hit.point.clone() : p);
    F.push(hit ? hit.faceIndex : -1);
  }
  return { P, F };
}
const storedPoints = (P, N) => P.map((p, i) => [p.x + N[i].x * STORE_LIFT, p.y + N[i].y * STORE_LIFT, p.z + N[i].z * STORE_LIFT]);

// ---- paint: copies of the mesh triangles near a stroke, coloured wherever they are within the brush radius of
// the stroke's centre line. The paint lies exactly on the surface, so it wraps around corners and bumps.
const CHUNK = 32; // centre-line points per paint piece (the shader checks the distance to each segment)
const paintVS = 'varying vec3 vW;\nvoid main() { vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const paintFS = `uniform vec3 uPts[${CHUNK + 1}];
uniform int uCount;
uniform float uR;
uniform vec3 uColor;
uniform float uRing;
varying vec3 vW;
void main() {
  float d = distance(vW, uPts[0]);
  for (int i = 0; i < ${CHUNK}; i++) {
    if (i + 1 >= uCount) break;
    vec3 a = uPts[i];
    vec3 ab = uPts[i + 1] - a;
    float t = clamp(dot(vW - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
    d = min(d, distance(vW, a + t * ab));
  }
  if (d > uR) discard;
  vec3 c = uColor;
  if (uRing > 0.5 && d > uR - max(1.5 * fwidth(d), 0.06 * uR)) c = vec3(1.0); // brush outline
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;
const _tc = new THREE.Vector3();
const _tri = new THREE.Triangle();
let paintSeq = 0; // later strokes draw over earlier ones
// mesh triangles within the brush radius of the centre line, reached by walking across connected triangles from
// the ones under the centre line, so paint never jumps onto a separate surface that happens to be close
function nearbyTriangles(pts, faces, r) {
  let gap = 0;
  for (let i = 1; i < pts.length; i++) gap = Math.max(gap, pts[i].distanceTo(pts[i - 1]));
  const reach2 = (r + gap / 2) ** 2;
  const pos = occ.geometry.attributes.position.array;
  const idx = occ.geometry.index.array;
  const A = triAdj;
  const stamp = ++A.stamp;
  const queue = [];
  for (const f of faces) if (f >= 0 && A.seen[f] !== stamp) { A.seen[f] = stamp; queue.push(f); }
  const out = [];
  while (queue.length) {
    const f = queue.pop();
    _tri.a.fromArray(pos, idx[3 * f] * 3);
    _tri.b.fromArray(pos, idx[3 * f + 1] * 3);
    _tri.c.fromArray(pos, idx[3 * f + 2] * 3);
    let near = false;
    for (const p of pts) {
      _tri.closestPointToPoint(p, _tc);
      if (_tc.distanceToSquared(p) <= reach2) { near = true; break; }
    }
    if (!near) continue;
    out.push(_tri.a.x, _tri.a.y, _tri.a.z, _tri.b.x, _tri.b.y, _tri.b.z, _tri.c.x, _tri.c.y, _tri.c.z);
    for (let k = 0; k < 3; k++) {
      const v = idx[3 * f + k];
      for (let j = A.start[v]; j < A.start[v + 1]; j++) {
        const g = A.tris[j];
        if (A.seen[g] !== stamp) { A.seen[g] = stamp; queue.push(g); }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.computeBoundingSphere();
  return g;
}
function paintPiece(pts, faces, r, color, ring = false) {
  const u = Array.from({ length: CHUNK + 1 }, (_, i) => pts[Math.min(i, pts.length - 1)].clone());
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPts: { value: u }, uCount: { value: pts.length }, uR: { value: r },
      uColor: { value: new THREE.Color(color) }, uRing: { value: ring ? 1 : 0 },
    },
    vertexShader: paintVS, fragmentShader: paintFS, side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, // in front of the invisible mesh it copies
  });
  const m = new THREE.Mesh(nearbyTriangles(pts, faces, r), mat);
  m.raycast = () => {};
  return m;
}
function newPaint() {
  const group = new THREE.Group();
  group.renderOrder = ++paintSeq;
  overlay.add(group);
  return { group, pieces: [] };
}
// (re)build the pieces of a centre line {P, F} from piece `from` on; returns the number of pieces
function paintFrom(paint, { P, F }, w, color, from) {
  const n = Math.max(1, Math.ceil((P.length - 1) / CHUNK));
  for (let k = from; k < n; k++) {
    const old = paint.pieces[k];
    if (old) { paint.group.remove(old); old.geometry.dispose(); old.material.dispose(); }
    const end = Math.min(P.length, (k + 1) * CHUNK + 1);
    const m = paintPiece(P.slice(k * CHUNK, end), F.slice(k * CHUNK, end), w / 2, color);
    m.renderOrder = paint.group.renderOrder;
    paint.pieces[k] = m;
    paint.group.add(m);
  }
  return n;
}
function dropPaint(paint) {
  overlay.remove(paint.group);
  for (const m of paint.pieces) { m.geometry.dispose(); m.material.dispose(); }
}

// ---- brush cursor: a dab of the paint itself (same colour and size), lying on the surface under the mouse
let mouse = null; // last pointer position over the canvas
let brushMesh = null;
let brushKey = '';
function updateBrush() {
  const h = mode === 'draw' && mouse && !look ? pickAt(mouse.x, mouse.y) : null;
  $('cursor').style.display = mode === 'draw' && !h ? 'block' : 'none';
  if (!h) { if (brushMesh) brushMesh.visible = false; return; }
  const w = brushWidth();
  const color = $('color').value;
  const key = `${h.point.x.toFixed(4)},${h.point.y.toFixed(4)},${h.point.z.toFixed(4)},${w},${color}`;
  if (key !== brushKey) {
    brushKey = key;
    if (brushMesh) { overlay.remove(brushMesh); brushMesh.geometry.dispose(); brushMesh.material.dispose(); }
    brushMesh = paintPiece([h.point], [h.face], w / 2, color, true);
    brushMesh.renderOrder = 1e9; // on top of all paint
    overlay.add(brushMesh);
  }
  brushMesh.visible = true;
}

// ---- drawing: the path between pointer events is re-sampled every few pixels on screen and each sample is
// ray cast, so the stroke follows the real surface (around corners) instead of cutting straight across
const MAX_PTS = 4000;
const SAMPLE_PX = 3;
const JUMP_M = 0.3; // gap between neighbouring samples that means the path jumped to another surface (grows with distance)
let cur = null; // {P, F, N, D, width, color, drag, paint, done, dirty}
let dragNo = 0;
let lastXY = null;
function startStroke(h, drag) {
  cur = { P: [], F: [], N: [], D: [], width: brushWidth(), color: $('color').value, drag, paint: null, done: 0, dirty: false };
  addPoint(h);
}
function addPoint(h) {
  const last = cur.P[cur.P.length - 1];
  if (last) {
    const d = h.point.distanceTo(last);
    if (d < Math.max(0.004, cur.width * 0.12)) return;
    const jump = Math.max(JUMP_M, 0.15 * Math.min(h.dist, cur.D[cur.D.length - 1])); // seen from far, samples spread out
    if (d > jump) { const drag = cur.drag; finishStroke(); startStroke(h, drag); return; }
  }
  if (cur.P.length >= MAX_PTS) return;
  cur.P.push(h.point);
  cur.F.push(h.face);
  cur.N.push(h.normal);
  cur.D.push(h.dist);
  cur.dirty = true;
}
function drawTo(x, y) {
  const [x0, y0] = lastXY;
  const steps = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / SAMPLE_PX));
  for (let i = 1; i <= steps; i++) {
    const h = pickAt(x0 + ((x - x0) * i) / steps, y0 + ((y - y0) * i) / steps);
    if (h && cur) addPoint(h);
  }
  lastXY = [x, y];
}
function updatePreview() {
  if (!cur || !cur.dirty) return;
  cur.dirty = false;
  if (!cur.paint) cur.paint = newPaint();
  cur.done = paintFrom(cur.paint, cur, cur.width, cur.color, cur.done) - 1; // only the last piece still grows
}
async function finishStroke() {
  if (!cur) return;
  const c = cur;
  cur = null;
  const s = { author: $('author').value.trim(), color: c.color, width: c.width, points: storedPoints(c.P, c.N) };
  try {
    const id = await backend.add(s);
    dragOf.set(id, c.drag);
    addStroke({ ...s, id, mine: true }, { P: c.P, F: c.F });
    if (!myIds.includes(id)) myIds.push(id);
    setStatus(`${strokes.size} strokes`);
  } catch (e) {
    setStatus('! Saving failed');
    console.error(e);
  } finally {
    if (c.paint) dropPaint(c.paint);
  }
}

// ---- pointer / keyboard
let look = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (mode === 'draw' && e.button === 0) {
    const h = pickAt(e.clientX, e.clientY);
    lastXY = [e.clientX, e.clientY];
    if (h) startStroke(h, ++dragNo);
  } else {
    look = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = mode === 'draw' ? 'none' : 'grabbing';
  }
});
canvas.addEventListener('pointermove', (e) => {
  const c = $('cursor');
  c.style.left = `${e.clientX}px`;
  c.style.top = `${e.clientY}px`;
  mouse = { x: e.clientX, y: e.clientY };
  if (look) {
    cam.yaw += (e.clientX - look.x) * 0.004;
    cam.pitch = THREE.MathUtils.clamp(cam.pitch + (e.clientY - look.y) * 0.004, -1.45, 1.45);
    look = { x: e.clientX, y: e.clientY };
  } else if (cur && lastXY) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : []; // all mouse samples since the last event
    for (const ev of evs.length ? evs : [e]) drawTo(ev.clientX, ev.clientY);
  }
});
canvas.addEventListener('pointerleave', () => { mouse = null; });
const endPointer = () => {
  if (cur) finishStroke();
  lastXY = null;
  look = null;
  canvas.style.cursor = mode === 'draw' ? 'none' : 'grab';
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (photoPose) return; // keep the photo view until the user drags or uses the keys
  cam.pos.addScaledVector(forward3(), -e.deltaY * 0.003);
}, { passive: false });

const keys = new Set();
const FWD = ['ArrowUp', 'KeyW'];
let lastFwdTap = 0;
let sprint = false;
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  if (e.code === 'KeyG') { setMode(mode === 'draw' ? 'look' : 'draw'); return; }
  if (e.code === 'KeyZ' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); undo(); return; }
  if (FWD.includes(e.code) && !e.repeat) { // double-tap forward = run while held
    const now = performance.now();
    sprint = now - lastFwdTap < 300;
    lastFwdTap = now;
  }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (!FWD.some((k) => keys.has(k))) sprint = false;
});
window.addEventListener('blur', () => { keys.clear(); sprint = false; });

function move(dt) {
  const v = (sprint || keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4.5 : 1.5) * dt;
  const f = new THREE.Vector3(Math.cos(cam.yaw), Math.sin(cam.yaw), 0);
  const r = new THREE.Vector3(Math.sin(cam.yaw), -Math.cos(cam.yaw), 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) cam.pos.addScaledVector(f, v);
  if (keys.has('KeyS') || keys.has('ArrowDown')) cam.pos.addScaledVector(f, -v);
  if (keys.has('KeyD')) cam.pos.addScaledVector(r, v);
  if (keys.has('KeyA')) cam.pos.addScaledVector(r, -v);
  if (keys.has('ArrowLeft')) cam.yaw += 1.5 * dt;
  if (keys.has('ArrowRight')) cam.yaw -= 1.5 * dt;
  if (keys.has('KeyE')) cam.pos.z += v;
  if (keys.has('KeyQ')) cam.pos.z -= v;
}

// ---- photo localisation: upload a photo, jump to where it was taken, overlay it for comparison
let photoPose = null; // {quat, hfov, aspect} while the view is locked to the photo
const photoEl = $('photo');
if (backend !== serverBackend) $('locBtn').hidden = true; // needs the Python server (GPU + dataset)
$('locBtn').addEventListener('click', () => $('locFile').click());
$('locFile').addEventListener('change', async () => {
  const file = $('locFile').files[0];
  $('locFile').value = '';
  if (!file) return;
  setStatus('Locating…');
  const fd = new FormData();
  fd.append('photo', file);
  try {
    const r = await (await fetch('api/localize', { method: 'POST', body: fd })).json();
    if (!r.ok) { setStatus(`! Could not locate the photo (${r.inliers ?? 0} matches). Try a view with doors, signs or furniture`); return; }
    // OpenCV camera (x right, y down, z forward) -> three.js camera (x right, y up, z back)
    const c = r.c2w;
    const m = new THREE.Matrix4().set(
      c[0][0], -c[0][1], -c[0][2], 0,
      c[1][0], -c[1][1], -c[1][2], 0,
      c[2][0], -c[2][1], -c[2][2], 0,
      0, 0, 0, 1);
    cam.pos.set(...r.position);
    cam.yaw = r.yaw;
    cam.pitch = r.pitch;
    photoPose = { quat: new THREE.Quaternion().setFromRotationMatrix(m), hfov: r.hfov_deg, aspect: r.width / r.height };
    photoEl.src = URL.createObjectURL(file);
    photoEl.style.display = 'block';
    $('photoCtl').hidden = false;
    layoutPhoto();
    setStatus(`! Located: nearest station ${r.nearest_station}, ${r.inliers} matches, field of view ${Math.round(r.hfov_deg)}° (${r.focal_from}), ${r.seconds} s`);
  } catch (e) {
    setStatus('! Localization request failed');
    console.error(e);
  }
});
function layoutPhoto() {
  if (!photoPose) return;
  // show the photo with the same horizontal field of view as the 3D view
  const w = window.innerWidth;
  photoEl.style.width = `${w}px`;
  photoEl.style.height = `${w / photoPose.aspect}px`;
}
window.addEventListener('resize', layoutPhoto);
$('photoOpacity').addEventListener('input', () => { photoEl.style.opacity = $('photoOpacity').value / 100; });
function leavePhoto() {
  if (!photoPose) return;
  photoPose = null;
  camera.fov = 70;
  camera.updateProjectionMatrix();
}
$('photoClose').addEventListener('click', () => {
  leavePhoto();
  photoEl.style.display = 'none';
  $('photoCtl').hidden = true;
  if (!statusMsg.startsWith('! Cannot')) setStatus(`${strokes.size} strokes`);
});

// ---- render loop: splats, then (depth cleared) invisible mesh + strokes on top
const clock = new THREE.Clock();
renderer.autoClear = false;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  move(dt);
  updatePreview();
  updateBrush();
  sendMe(performance.now());
  const online = !live ? '' : live.isConnected() ? `● ${players.size + 1} online` : 'reconnecting…';
  if ($('online').textContent !== online) $('online').textContent = online;
  if (photoPose && (look || keys.size)) {  // user moved: hide the photo, back to free camera
    leavePhoto();
    photoEl.style.display = 'none';
    $('photoCtl').hidden = true;
  }
  if (photoPose) {
    camera.position.copy(cam.pos);
    camera.quaternion.copy(photoPose.quat);
    const vfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(photoPose.hfov) / 2) / camera.aspect);
    camera.fov = THREE.MathUtils.radToDeg(vfov);
    camera.updateProjectionMatrix();
  } else {
    applyCamera();
  }
  viewer.update();
  renderer.clear();
  viewer.render();
  renderer.clearDepth();
  renderer.render(overlay, camera);
  $('status').textContent = statusMsg.replace(/^! /, '');
}
frame();
