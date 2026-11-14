// 3D graffiti on the Gaussian-splat model of the building.
// Everything is in the BIM frame (metres, Z up). The decimated Metashape mesh is drawn invisibly: it is what
// strokes stick to, and it writes depth so strokes behind walls are hidden.
import * as THREE from 'three';
import * as GS from '@mkkellogg/gaussian-splats-3d';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

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
let backend = browserBackend;
try {
  const r = await api('api/strokes');
  if (r.ok && (r.headers.get('content-type') || '').includes('json')) backend = serverBackend;
} catch { /* no server: offline package */ }

// ---- renderer / camera
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
(async () => {
  const [pos, idx] = await Promise.all(['data/mesh_pos.bin', 'data/mesh_idx.bin']
    .map((u) => fetch(u).then((r) => r.arrayBuffer())));
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  geom.computeVertexNormals();
  geom.computeBoundsTree();
  occ = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
  }));
  occ.renderOrder = -1;
  overlay.add(occ);
  meshViz = new THREE.Mesh(geom, new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
  meshViz.raycast = () => {};
  meshViz.visible = $('showMesh').checked;
  overlay.add(meshViz);
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
function strokeObject(s) {
  const pts = s.points.map((p) => new THREE.Vector3(...p));
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(s.color) });
  const g = new THREE.Group();
  const r = s.width / 2;
  if (pts.length > 1) {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(pts.length * 3, 1500), r, 8, false), mat));
  }
  for (const p of pts.length > 1 ? [pts[0], pts[pts.length - 1]] : pts) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), mat);
    cap.position.copy(p);
    g.add(cap);
  }
  g.traverse((o) => { o.raycast = () => {}; });
  return g;
}
function addStroke(s) {
  if (strokes.has(s.id)) return;
  const obj = strokeObject(s);
  overlay.add(obj);
  strokes.set(s.id, { obj, data: s });
}
function removeStroke(id) {
  const s = strokes.get(id);
  if (!s) return;
  overlay.remove(s.obj);
  s.obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
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
sync();
if (backend === serverBackend) setInterval(sync, 3000);

$('undo').addEventListener('click', async () => {
  const id = myIds[myIds.length - 1];
  if (id === undefined) { setStatus('Nothing to undo'); return; }
  if (await backend.remove(id)) { removeStroke(id); myIds.pop(); setStatus(`${strokes.size} strokes`); }
});

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
    await sync();
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

// ---- picking
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const ndc = new THREE.Vector2();
const MAX_DRAW_M = 12;
function pick(e) {
  if (!occ) return null;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const h = raycaster.intersectObject(occ, false)[0];
  if (!h || h.distance > MAX_DRAW_M) return null;
  const n = h.face.normal.clone();
  if (n.dot(raycaster.ray.direction) > 0) n.negate();
  return h.point.clone().addScaledVector(n, 0.012); // sit just in front of the surface
}

// ---- drawing
const MAX_PTS = 4000;
let cur = null; // {pts, line}
function startStroke(p) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PTS * 3), 3));
  geo.setDrawRange(0, 0);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: $('color').value }));
  line.frustumCulled = false;
  overlay.add(line);
  cur = { pts: [], line };
  addPoint(p);
}
function addPoint(p) {
  const w = $('width').value / 100;
  const last = cur.pts[cur.pts.length - 1];
  if (last) {
    const d = p.distanceTo(last);
    if (d < Math.max(0.008, w * 0.25)) return;
    if (d > 0.5) { finishStroke(); startStroke(p); return; } // jumped to another surface: new stroke
  }
  if (cur.pts.length >= MAX_PTS) return;
  cur.line.geometry.attributes.position.setXYZ(cur.pts.length, p.x, p.y, p.z);
  cur.pts.push(p);
  cur.line.geometry.attributes.position.needsUpdate = true;
  cur.line.geometry.setDrawRange(0, cur.pts.length);
}
async function finishStroke() {
  if (!cur) return;
  const { pts, line } = cur;
  cur = null;
  const s = {
    author: $('author').value.trim(), color: $('color').value, width: $('width').value / 100,
    points: pts.map((p) => [p.x, p.y, p.z]),
  };
  try {
    const id = await backend.add(s);
    addStroke({ ...s, id, mine: true });
    myIds.push(id);
    setStatus(`${strokes.size} strokes`);
  } catch (e) {
    setStatus('! Saving failed');
    console.error(e);
  } finally {
    overlay.remove(line);
    line.geometry.dispose();
  }
}

// ---- pointer / keyboard
let look = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (mode === 'draw' && e.button === 0) {
    const p = pick(e);
    if (p) startStroke(p);
  } else {
    look = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = mode === 'draw' ? 'none' : 'grabbing';
  }
});
canvas.addEventListener('pointermove', (e) => {
  const c = $('cursor');
  c.style.left = `${e.clientX}px`;
  c.style.top = `${e.clientY}px`;
  if (look) {
    cam.yaw -= (e.clientX - look.x) * 0.004;
    cam.pitch = THREE.MathUtils.clamp(cam.pitch - (e.clientY - look.y) * 0.004, -1.45, 1.45);
    look = { x: e.clientX, y: e.clientY };
  } else if (cur) {
    const p = pick(e);
    if (p) addPoint(p);
  }
});
const endPointer = () => {
  if (cur) finishStroke();
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
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  if (e.code === 'KeyG') { setMode(mode === 'draw' ? 'look' : 'draw'); return; }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function move(dt) {
  const v = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4.5 : 1.5) * dt;
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
  move(Math.min(clock.getDelta(), 0.1));
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
