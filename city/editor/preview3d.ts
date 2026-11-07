// 3D 미리보기 소창: three.js(r128, 게임과 같은 CDN)로 보는 중심 주변의 지형·도로·건물·앵커를 간이 표시.
// three 를 못 불러오면(오프라인 등) 같은 자료를 2D 캔버스 의사 3D 와이어로 대신 보여 준다(preview-fallback.ts).
import {drawFallback} from './preview-fallback.js';
import {buildPvData, type PvData} from './preview-data.js';
import {CLS_COLOR} from './draw.js';
import {ed} from './state.js';

declare const THREE: any;
const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const STYLE_COLOR: Record<string, number> = {house: 0xe8c9a0, shop: 0xf0b86e, apartment: 0xb9a6e8, office: 0x8fb8e8, highrise: 0x7aa0d8, civic: 0xe0a0c8, barn: 0xc8946a, lodge: 0xb08a5a, landmark: 0xffd24a};

export interface PvStats { mode: 'three' | 'fallback' | 'none'; meshes: number; tris: number; roads: number; buildings: number; anchors: number; src: string; msg: string }
export const pvStats: PvStats = {mode: 'none', meshes: 0, tris: 0, roads: 0, buildings: 0, anchors: 0, src: '', msg: ''};
let cam = {yaw: 0.6, pitch: 0.7, dist: 1}, radius = 250, threeState: 'idle' | 'loading' | 'ok' | 'fail' = 'idle';
let renderer: any, scene: any, camera: any, group: any, cvEl: HTMLCanvasElement, data: PvData | null = null;

function loadThree(): Promise<boolean> {
  if ((window as any).THREE) return Promise.resolve(true);
  return new Promise(res => {
    const s = document.createElement('script');
    const t = window.setTimeout(() => { s.remove(); res(false); }, 8000);
    s.src = THREE_URL; s.onload = () => { clearTimeout(t); res(!!(window as any).THREE); }; s.onerror = () => { clearTimeout(t); res(false); };
    document.head.append(s);
  });
}
const colorOf = (y: number, _lo: number, hi: number) => {
  if (y < -0.5) return [0.25, 0.45, 0.6]; // 해수면(≈-4.6)~해안 아래
  const v = Math.max(0, Math.min(1, y / Math.max(10, hi)));
  return v < 0.6 ? [0.3 + v * 0.3, 0.55 - v * 0.1, 0.25] : [0.5 + v * 0.4, 0.45 + v * 0.4, 0.4 + v * 0.45];
};
function disposeGroup() {
  if (!group) return;
  group.traverse((o: any) => { o.geometry?.dispose?.(); (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []).forEach((m: any) => m.dispose?.()); });
  scene.remove(group); group = null;
}
function build(d: PvData) {
  disposeGroup();
  group = new THREE.Group();
  const n = d.n, pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const y = d.heights[j * (n + 1) + i]; pos.push(d.x0 + i * d.step - d.cx, y, d.z0 + j * d.step - d.cz); col.push(...colorOf(y, d.minY, d.maxY));
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, e = c + 1; idx.push(a, c, b, b, c, e); }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); tg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); tg.setIndex(idx); tg.computeVertexNormals();
  group.add(new THREE.Mesh(tg, new THREE.MeshLambertMaterial({vertexColors: true})));
  let tris = idx.length / 3, meshes = 1;
  for (const r of d.roads) {
    const p = r.xyz, rp: number[] = [], ri: number[] = [], hw = Math.max(1.5, r.w / 2);
    const m = p.length / 3;
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1), dx = p[b * 3] - p[a * 3], dz = p[b * 3 + 2] - p[a * 3 + 2], l = Math.hypot(dx, dz) || 1, nx = -dz / l * hw, nz = dx / l * hw;
      rp.push(p[i * 3] - d.cx + nx, p[i * 3 + 1] + 0.3, p[i * 3 + 2] - d.cz + nz, p[i * 3] - d.cx - nx, p[i * 3 + 1] + 0.3, p[i * 3 + 2] - d.cz - nz);
      if (i < m - 1) ri.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3)); g.setIndex(ri);
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({color: new THREE.Color(CLS_COLOR[r.cls] ?? '#ccc'), side: THREE.DoubleSide})));
    tris += ri.length / 3; meshes++;
  }
  for (const b of d.buildings) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), new THREE.MeshLambertMaterial({color: STYLE_COLOR[b.style] ?? 0xcccccc}));
    m.position.set(b.x - d.cx, b.y + b.h / 2, b.z - d.cz); m.rotation.y = (b.rot * Math.PI) / 180; group.add(m); tris += 12; meshes++;
  }
  for (const a of d.anchors) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(2, 9, 8), new THREE.MeshBasicMaterial({color: a.fixed ? 0xee3333 : 0xffffff}));
    m.position.set(a.x - d.cx, a.y + 4.5, a.z - d.cz); group.add(m); tris += 16; meshes++;
  }
  scene.add(group);
  Object.assign(pvStats, {mode: 'three', meshes, tris, roads: d.roads.length, buildings: d.buildings.length, anchors: d.anchors.length, src: d.src, msg: ''});
}
function place() {
  const d = data;
  if (!d || !camera) return;
  const dist = cam.dist * radius * 1.6, cy = (d.minY + d.maxY) / 2;
  camera.position.set(Math.sin(cam.yaw) * Math.cos(cam.pitch) * dist, cy + Math.sin(cam.pitch) * dist, Math.cos(cam.yaw) * Math.cos(cam.pitch) * dist);
  camera.lookAt(0, cy, 0);
}
export function renderPreview() {
  if (!cvEl) return;
  if (threeState === 'ok' && renderer && data) { place(); renderer.render(scene, camera); }
  else if (data) drawFallback(cvEl, data, cam);
}
/** 현재 2D 보기의 중심 주변으로 다시 만든다 */
export async function refreshPreview(): Promise<void> {
  cvEl = document.getElementById('pv-cv') as HTMLCanvasElement;
  const msg = document.getElementById('pv-msg')!;
  data = buildPvData(ed.view.cx, ed.view.cz, radius);
  if (!data) { Object.assign(pvStats, {mode: 'none', msg: '지형이 아직 없어 표시할 수 없음'}); msg.textContent = ed.terrainMsg || '지형을 불러오는 중이거나 불러오지 못했습니다'; return; }
  if (threeState === 'idle') { threeState = 'loading'; msg.textContent = 'three.js 불러오는 중…'; threeState = (await loadThree()) ? 'ok' : 'fail'; }
  if (threeState === 'ok') {
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({canvas: cvEl, antialias: true, preserveDrawingBuffer: true}); renderer.setSize(cvEl.width, cvEl.height, false); renderer.setClearColor(0x101820);
      scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(50, cvEl.width / cvEl.height, 1, 6000);
      scene.add(new THREE.AmbientLight(0xffffff, 0.65)); const dl = new THREE.DirectionalLight(0xffffff, 0.7); dl.position.set(200, 400, 120); scene.add(dl);
    }
    build(data); msg.textContent = `3D · 반경 ${radius}m · ${data.src === 'compiled' ? '컴파일 결과 도로/건물' : '원본 추정(다시 빌드하면 정확)'}`;
  } else {
    Object.assign(pvStats, {mode: 'fallback', meshes: 0, tris: 0, roads: data.roads.length, buildings: data.buildings.length, anchors: data.anchors.length, src: data.src, msg: 'three.js 로드 실패'});
    msg.textContent = 'three.js 를 불러오지 못해(오프라인?) 2D 와이어 폴백으로 표시합니다';
  }
  renderPreview();
}
export function bindPreview() {
  const cv = document.getElementById('pv-cv') as HTMLCanvasElement;
  let drag: {x: number; y: number} | null = null;
  cv.addEventListener('mousedown', e => { drag = {x: e.clientX, y: e.clientY}; });
  window.addEventListener('mouseup', () => { drag = null; });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    cam.yaw -= (e.clientX - drag.x) * 0.01; cam.pitch = Math.max(0.12, Math.min(1.45, cam.pitch + (e.clientY - drag.y) * 0.01)); drag = {x: e.clientX, y: e.clientY}; renderPreview();
  });
  cv.addEventListener('wheel', e => { e.preventDefault(); cam.dist = Math.max(0.25, Math.min(3, cam.dist * Math.exp(e.deltaY * 0.001))); renderPreview(); }, {passive: false});
  (document.getElementById('pv-radius') as HTMLSelectElement).onchange = e => { radius = +(e.target as HTMLSelectElement).value; void refreshPreview(); };
  document.getElementById('pv-refresh')!.onclick = () => void refreshPreview();
  document.getElementById('pv-close')!.onclick = () => closePreview();
}
export function openPreview() { document.getElementById('pv')!.classList.remove('hidden'); void refreshPreview(); }
export function closePreview() { document.getElementById('pv')!.classList.add('hidden'); }
export const previewOpen = () => !document.getElementById('pv')!.classList.contains('hidden');
