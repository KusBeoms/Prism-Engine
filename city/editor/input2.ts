// 캔버스 객체 입력(구역·앵커·건물·노드·지형 브러시): 선택/드래그/회전 핸들/그리기/삭제. input.ts 가 먼저 불러 처리 여부를 돌려받는다.
import type {Pt} from '../city-schema.js';
import {LIMITS} from '../city-schema.js';
import {ROT_HANDLE_PX} from './draw2.js';
import {addAnchor, addBuilding, addZone, deleteObj, deleteZoneVertex, hitAnchor, hitBuilding, hitNode, hitPolyEdge, hitPolyVert, hitZone, insertZoneVertex, uniqueId} from './objops.js';
import {round1} from './roadops.js';
import {paintZones} from './zone-brush.js';
import {ed, emit, mutateDoc, objOf, pushUndo, selectObj, setMsg, touched} from './state.js';

type Snap = (x: number, z: number) => Pt;
type Drag =
  | {k: 'zvert'; id: string; idx: number; started: boolean}
  | {k: 'move'; kind: 'anchor' | 'building'; id: string; ox: number; oz: number; started: boolean}
  | {k: 'rot'; id: string; started: boolean}
  | {k: 'stroke'}
  | {k: 'zstroke'};
let drag: Drag | null = null;
export const dragging = () => drag !== null;

/** 도구(zone/anchor/building/brush) 모드의 클릭. 처리했으면 true. zone = 구역 브러시: ⌥ 지우개, ⇧ 새 구역 강제 */
export function toolDown(wx: number, wz: number, snap: Snap, mods: {alt: boolean; shift: boolean} = {alt: false, shift: false}): boolean {
  const p = snap(wx, wz);
  if (ed.tool === 'zone') {
    const hit = mods.alt || mods.shift ? undefined : hitZone(wx, wz);
    ed.zmode = mods.alt ? 'erase' : hit ? 'extend' : 'new';
    ed.zmodeUse = hit ? hit.use : ed.zoneUse; zTarget = hit ? hit.id : null;
    ed.stroke = [[round1(wx), round1(wz)]]; drag = {k: 'zstroke'}; emit('view'); return true;
  }
  if (ed.tool === 'anchor') { addAnchor(p[0], p[1]); return true; }
  if (ed.tool === 'building') { addBuilding(p[0], p[1]); return true; }
  if (ed.tool === 'brush') { ed.stroke = [[round1(wx), round1(wz)]]; drag = {k: 'stroke'}; emit('view'); return true; }
  return false;
}
let zTarget: string | null = null;
/** 구역 브러시 스트로크 1회 = 실행 취소 1단계 */
function finishZoneStroke(pts: Pt[]) {
  const mode = ed.zmode as 'extend' | 'new' | 'erase', use = ed.zoneUse;
  ed.zmode = '';
  const doc = ed.doc;
  if (!doc || !pts.length || !mode) return;
  const res = paintZones(doc.zones, pts, ed.zbr, mode, zTarget, use);
  if (!res.changed) { setMsg(res.msg || '변화 없음'); return; }
  mutateDoc(d => { d.zones = res.zones; });
  if (res.focus) selectObj('zone', res.focus);
  setMsg(res.msg);
}
/** 선택 모드. phase 'pre' = 도로보다 먼저(핸들·노드·앵커·건물), 'post' = 도로가 없을 때(구역 안쪽) */
export function selDown(wx: number, wz: number, tol: number, phase: 'pre' | 'post'): boolean {
  if (phase === 'post') {
    const z = hitZone(wx, wz);
    if (z) { selectObj('zone', z.id); return true; }
    return false;
  }
  const s = ed.selObj;
  if (s?.kind === 'zone') {
    const z = objOf<{poly: Pt[]}>(s);
    const vi = z ? hitPolyVert(z.poly, wx, wz, tol) : -1;
    if (z && vi >= 0) { selectObj('zone', s.id, vi); drag = {k: 'zvert', id: s.id, idx: vi, started: false}; return true; }
  }
  if (s?.kind === 'anchor') {
    const a = objOf<{x: number; z: number; rot?: number; fixed: boolean}>(s);
    if (a) {
      const r = (a.rot ?? 0) * Math.PI / 180, L = ROT_HANDLE_PX / ed.view.scale;
      if (Math.hypot(a.x + Math.sin(r) * L - wx, a.z + Math.cos(r) * L - wz) <= tol) { drag = {k: 'rot', id: s.id, started: false}; return true; }
    }
  }
  const n = hitNode(wx, wz, tol);
  if (n) { selectObj('node', n.id); return true; }
  const a = hitAnchor(wx, wz, tol);
  if (a) {
    selectObj('anchor', a.id);
    if (a.fixed) setMsg(`고정 앵커 ${a.id}: 이동·삭제 불가 (속성에서 고정 해제)`);
    else drag = {k: 'move', kind: 'anchor', id: a.id, ox: a.x - wx, oz: a.z - wz, started: false};
    return true;
  }
  const b = hitBuilding(wx, wz);
  if (b) { selectObj('building', b.id); drag = {k: 'move', kind: 'building', id: b.id, ox: b.x - wx, oz: b.z - wz, started: false}; return true; }
  return false;
}
export function objMove(wx: number, wz: number, snap: Snap): boolean {
  const d = drag;
  if (!d || !ed.doc) return false;
  if (d.k === 'zstroke') {
    const last = ed.stroke[ed.stroke.length - 1];
    if (Math.hypot(last[0] - wx, last[1] - wz) >= Math.max(1, ed.zbr / 3) && ed.stroke.length < 1500) { ed.stroke.push([round1(wx), round1(wz)]); emit('view'); }
    return true;
  }
  if (d.k === 'stroke') {
    const last = ed.stroke[ed.stroke.length - 1], step = Math.max(1.5, ed.brush.r / 3);
    if (Math.hypot(last[0] - wx, last[1] - wz) >= step && ed.stroke.length < LIMITS.strokePts) { ed.stroke.push([round1(wx), round1(wz)]); emit('view'); }
    return true;
  }
  if (d.k === 'zvert') {
    const z = ed.doc.zones.find(q => q.id === d.id);
    if (!z) return true;
    const p = snap(wx, wz);
    if (!d.started) { if (Math.hypot(z.poly[d.idx][0] - p[0], z.poly[d.idx][1] - p[1]) < 0.05) return true; pushUndo(); d.started = true; }
    z.poly[d.idx] = p; touched('geom'); return true;
  }
  if (d.k === 'move') {
    const o = d.kind === 'anchor' ? ed.doc.anchors.find(q => q.id === d.id) : ed.doc.buildings.find(q => q.id === d.id);
    if (!o) return true;
    const p = snap(wx + d.ox, wz + d.oz);
    if (!d.started) { if (Math.hypot(o.x - p[0], o.z - p[1]) < 0.05) return true; pushUndo(); d.started = true; }
    o.x = p[0]; o.z = p[1]; touched('geom'); return true;
  }
  const a = ed.doc.anchors.find(q => q.id === d.id);
  if (!a) return true;
  const deg = Math.round(((Math.atan2(wx - a.x, wz - a.z) * 180) / Math.PI + 360) % 360 / 5) * 5 % 360;
  if (!d.started) { if ((a.rot ?? 0) === deg) return true; pushUndo(); d.started = true; }
  a.rot = deg; touched('geom'); return true;
}
export function objUp(): boolean {
  const d = drag;
  if (!d) return false;
  drag = null;
  if (d.k === 'zstroke') { const pts = ed.stroke; ed.stroke = []; finishZoneStroke(pts); emit('view'); return true; }
  if (d.k === 'stroke') {
    const pts = ed.stroke; ed.stroke = [];
    if (pts.length) {
      const id = uniqueId('ed-brush', 'edit'), b = ed.brush;
      mutateDoc(doc => { doc.terrain.edits.push({kind: 'brush', id, mode: b.mode, r: b.r, strength: b.strength, pts}); });
      selectObj('edit', id); setMsg(`지형 브러시 ${id} 추가 (${b.mode}, ${pts.length}점)`);
    }
    emit('view'); return true;
  }
  if ('started' in d && d.started) touched('doc');
  return true;
}
export function objDbl(wx: number, wz: number, tol: number): boolean {
  const s = ed.selObj;
  if (s?.kind !== 'zone') return false;
  const z = objOf<{poly: Pt[]}>(s);
  if (!z || hitPolyVert(z.poly, wx, wz, tol) >= 0) return false;
  const e = hitPolyEdge(z.poly, wx, wz, tol * 1.5);
  if (!e) return false;
  insertZoneVertex(z as never, e.i, e.p); selectObj('zone', s.id, e.i + 1); return true;
}
/** Delete 키 처리(객체 선택 중). 처리했으면 true */
export function deleteObjSelection(): boolean {
  const s = ed.selObj;
  if (!s) return false;
  if (s.kind === 'node') { setMsg('노드는 직접 지우지 않습니다 (도로를 지우면 함께 정리됨)'); return true; }
  if (s.kind === 'zone' && s.vert >= 0) {
    const z = objOf<{poly: Pt[]}>(s);
    if (z && deleteZoneVertex(z as never, s.vert)) { selectObj('zone', s.id); return true; }
    setMsg('구역은 점이 3개 이상 필요합니다'); return true;
  }
  deleteObj(s); return true;
}
/** 선택한 앵커·건물을 delta(도) 만큼 돌린다 */
export function rotateSel(delta: number): boolean {
  const o = objOf<{rot?: number; interior?: unknown; fixed?: boolean}>(ed.selObj);
  if (!o || !ed.selObj || (ed.selObj.kind !== 'anchor' && ed.selObj.kind !== 'building')) return false;
  mutateDoc(() => { o.rot = (((o.rot ?? 0) + delta) % 360 + 360) % 360; });
  return true;
}
