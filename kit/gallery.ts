// 디버그 갤러리: ?gallery=1 일 때 프리미티브·팔레트·샘플을 전시한다. 게임 상태(G, S)와 무관하게 자체 렌더러를 쓴다.
// 드래그 = 회전, 휠 = 확대, 숫자 1~4 = 낮/황혼/밤/새벽 틴트
import {CITY, NEUTRAL, ACCENT, PAL, TINT, type Tint} from './palette.js';
import {box, cone, cyl, gable, ico, panel, prism, taper, wedge, type Geo} from './prim.js';
import {countTris, glowMat, lowMat, mergePlaced} from './merge.js';
import {sampleBuilding, sampleLamp, sampleRock, sampleTree, type Part} from './samples.js';

const ID = 'lowpoly-gallery';
const TINTS = ['day', 'dusk', 'night', 'dawn'] as const;

interface Entry {
  name: string;
  obj: any;
}

const solid = (g: Geo) => new THREE.Mesh(g, lowMat());
function part(p: Part): any {
  const grp = new THREE.Group();
  grp.add(solid(p.solid));
  if (p.glow) grp.add(new THREE.Mesh(p.glow, glowMat()));
  return grp;
}

/** 색 목록을 얇은 타일 한 줄(메시 1개)로 */
function swatches(colors: readonly number[]): any {
  return solid(mergePlaced(colors.map((c, i) => ({g: box(1.5, 0.4, 1.5, c), x: (i - (colors.length - 1) / 2) * 1.8}))));
}

function buildEntries(): Entry[] {
  const prims: [string, Geo][] = [
    ['box', box(3, 3, 3, CITY.brick)],
    ['taper', taper(3.4, 3.4, 1.8, 1.8, 3, CITY.plaster)],
    ['prism6', prism(6, 1.6, 3, CITY.tileBlue)],
    ['cyl8', cyl(1.5, 3, PAL.teal)],
    ['cone8', cone(1.8, 3.2, PAL.green)],
    ['wedge', wedge(3.4, 2.4, 3.4, PAL.amber)],
    ['gable', gable(3.6, 2.4, 3.2, CITY.tileRed)],
    ['panel', panel(3, 3, PAL.cyan, 0, 1.5)],
    ['ico0', ico(1.6, 0, PAL.violet, 0, 1.6)],
    ['ico1', ico(1.6, 1, PAL.magenta, 0, 1.6)],
    ['ico2', ico(1.6, 2, PAL.pink, 0, 1.6)],
    ['ico3', ico(1.6, 3, PAL.red, 0, 1.6)],
  ];
  const place = (list: Entry[], z: number, gap: number) =>
    list.forEach((e, i) => e.obj.position.set((i - (list.length - 1) / 2) * gap, 0, z));
  const row1: Entry[] = prims.map(([name, g]) => ({name, obj: solid(g)}));
  const row2: Entry[] = [
    ...[1, 2, 3].map(s => ({name: `building${s}`, obj: part(sampleBuilding(s))})),
  ];
  const row3: Entry[] = [
    ...([0, 1, 2] as const).map(k => ({name: `tree${k}`, obj: part(sampleTree(k))})),
    {name: 'rock', obj: part(sampleRock(5))},
    {name: 'lamp', obj: part(sampleLamp())},
  ];
  place(row1, 0, 6);
  place(row2, 40, 32);
  place(row3, 18, 9);
  const pal: Entry[] = [
    {name: 'neutral', obj: swatches(Object.values(NEUTRAL))},
    {name: 'city', obj: swatches(Object.values(CITY))},
    {name: 'accent', obj: swatches(Object.values(ACCENT))},
  ];
  pal.forEach((e, i) => e.obj.position.z = -12 - i * 2.4);
  return [...row1, ...row2, ...row3, ...pal];
}

function applyTint(t: Tint, r: any, scene: any, hemi: any, sun: any) {
  r.setClearColor(t.sky);
  scene.fog.color.setHex(t.fog);
  hemi.color.setHex(t.hemiSky);
  hemi.groundColor.setHex(t.hemiGround);
  hemi.intensity = t.hemiK;
  sun.color.setHex(t.sun);
  sun.intensity = t.sunK;
}

export function showGallery() {
  if (document.getElementById(ID)) return;
  const root = document.createElement('div');
  root.id = ID;
  root.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;touch-action:none';
  const list = document.createElement('ul');
  list.style.cssText = 'position:absolute;left:8px;top:8px;margin:0;padding:6px 10px;list-style:none;font:11px monospace;color:#fff;background:#0008;pointer-events:none';
  const renderer = new THREE.WebGLRenderer({antialias: true}),
    scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 800),
    hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1),
    sun = new THREE.DirectionalLight(0xffffff, 1);
  scene.fog = new THREE.Fog(0xffffff, 200, 600);
  sun.position.set(30, 60, 20);
  scene.add(hemi, sun, solid(box(200, 0.5, 150, CITY.asphalt, 0, -0.5, -10)));

  let total = 0;
  for (const {name, obj} of buildEntries()) {
    const tris = countTris(obj);
    total += tris;
    scene.add(obj);
    const li = document.createElement('li');
    li.dataset.name = name;
    li.dataset.tris = String(tris);
    li.textContent = `${name} ${tris}`;
    list.append(li);
  }
  root.dataset.tris = String(total);
  root.append(renderer.domElement, list);
  document.body.append(root);

  let az = 0, polar = 0.95, dist = 140;
  const target = new THREE.Vector3(0, 0, -6),
    resize = () => {
      renderer.setSize(innerWidth, innerHeight);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    };
  resize();
  addEventListener('resize', resize);
  renderer.domElement.addEventListener('pointermove', (e: PointerEvent) => {
    if (!e.buttons) return;
    az -= e.movementX * 0.005;
    polar = Math.min(1.45, Math.max(0.2, polar - e.movementY * 0.005));
  });
  renderer.domElement.addEventListener('wheel', (e: WheelEvent) => (dist = Math.min(300, Math.max(20, dist * (1 + e.deltaY * 0.001)))));
  addEventListener('keydown', e => {
    const k = TINTS[Number(e.key) - 1];
    if (k) applyTint(TINT[k], renderer, scene, hemi, sun);
  });
  applyTint(TINT.day, renderer, scene, hemi, sun);

  const tick = () => {
    camera.position.set(
      target.x + dist * Math.sin(polar) * Math.sin(az),
      target.y + dist * Math.cos(polar),
      target.z + dist * Math.sin(polar) * Math.cos(az),
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
    root.dataset.calls = String(renderer.info.render.calls);
    root.dataset.renderTris = String(renderer.info.render.triangles);
    requestAnimationFrame(tick);
  };
  tick();
}
