// 구역·앵커·노드·건물·지형 편집 객체의 순수 연산(히트 테스트, 추가·삭제, 문 위치 보정). DOM 에 의존하지 않는다.
import {obbOverlap, toWorld as obbToWorld, type Obb} from '../gen/obb.js';
import {BUILDING_STYLES, SCALE, type AnchorSource, type BuildingSource, type BuildingStyle, type NodeKind, type Pt, type TerrainEdit, type ZoneSource, type ZoneUse} from '../city-schema.js';
import {deleteBuildingRefs, deleteZoneRefs, summarize, type Counts, zeroCounts} from './refs.js';
import {ed, mutateDoc, objList, select, selectObj, setMsg, type BldOpts, type ObjKind, type SelObj} from './state.js';

export function uniqueId(prefix: string, kind: ObjKind | 'zone'): string {
  const ids = new Set(objList(kind).map(o => o.id));
  for (let i = 1; ; i++) { const id = `${prefix}-${i}`; if (!ids.has(id)) return id; }
}
export function pointInPoly(x: number, z: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
export function polyArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; }
  return Math.abs(s / 2);
}
export const bldObb = (b: BuildingSource): Obb => ({cx: b.x, cz: b.z, hw: b.w / 2, hd: b.d / 2, rot: b.rot});
export function bldCorners(b: BuildingSource): Pt[] {
  const o = bldObb(b);
  return ([[-o.hw, -o.hd], [o.hw, -o.hd], [o.hw, o.hd], [-o.hw, o.hd]] as Pt[]).map(([lx, lz]) => obbToWorld(o, lx, lz) as Pt);
}
export const bldOverlap = (a: BuildingSource, b: BuildingSource, gap = 0) => obbOverlap(bldObb(a), bldObb(b), gap);

// ───────── 히트 테스트 ─────────
export function hitZone(x: number, z: number): ZoneSource | undefined {
  let best: ZoneSource | undefined, ba = Infinity;
  for (const zn of ed.doc?.zones ?? []) {
    if (!Array.isArray(zn.poly) || zn.poly.length < 3 || !pointInPoly(x, z, zn.poly)) continue;
    const a = polyArea(zn.poly);
    if (a < ba) { ba = a; best = zn; }
  }
  return best;
}
export function hitPolyVert(poly: Pt[], x: number, z: number, tol: number): number {
  let bi = -1, bd = tol;
  poly.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
/** 다각형 변 위의 점이면 (삽입 위치 i = 변 i→i+1, 투영점) */
export function hitPolyEdge(poly: Pt[], x: number, z: number, tol: number): {i: number; p: Pt} | null {
  let best: {i: number; p: Pt} | null = null, bd = tol;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], bx = b[0] - a[0], bz = b[1] - a[1], l2 = bx * bx + bz * bz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * bx + (z - a[1]) * bz) / l2)) : 0;
    const px = a[0] + bx * t, pz = a[1] + bz * t, d = Math.hypot(x - px, z - pz);
    if (d < bd) { bd = d; best = {i, p: [Math.round(px * 10) / 10, Math.round(pz * 10) / 10]}; }
  }
  return best;
}
export const hitAnchor = (x: number, z: number, tol: number): AnchorSource | undefined => (ed.doc?.anchors ?? []).find(a => Math.hypot(a.x - x, a.z - z) <= tol);
export function hitNode(x: number, z: number, tol: number) {
  let best, bd = tol;
  for (const n of ed.doc?.nodes ?? []) { const d = Math.hypot(n.at[0] - x, n.at[1] - z); if (d < bd) { bd = d; best = n; } }
  return best;
}
export function hitBuilding(x: number, z: number): BuildingSource | undefined {
  for (const b of [...(ed.doc?.buildings ?? [])].reverse()) {
    const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rot * Math.PI / 180), s = Math.sin(b.rot * Math.PI / 180);
    // obb.ts 규약: 로컬 +x -> (cos, -sin), +z -> (sin, cos)
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx) <= b.w / 2 && Math.abs(lz) <= b.d / 2) return b;
  }
  return undefined;
}

// ───────── 건물 ─────────
/** 문을 facing 쪽 가장자리에 맞춘다(치수·방향이 바뀐 뒤 호출) */
export function fitDoor(b: BuildingSource) {
  const d = b.interior.door, hw = b.w / 2, hd = b.d / 2, cl = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  if (d.facing === 's' || d.facing === 'n') { d.x = Math.round(cl(d.x, hw - 0.6) * 100) / 100; d.z = d.facing === 's' ? hd : -hd; }
  else { d.z = Math.round(cl(d.z, hd - 0.6) * 100) / 100; d.x = d.facing === 'e' ? hw : -hw; }
}
export function makeBuilding(id: string, x: number, z: number, o: BldOpts): BuildingSource {
  const floorH = SCALE.floorH[o.style];
  const b: BuildingSource = {
    id, x, z, w: o.w, d: o.d, rot: o.rot, floors: o.floors, style: o.style,
    interior: {mode: 'onsite', door: {x: 0, z: o.d / 2, w: SCALE.door.w, h: SCALE.door.h, facing: 's'}, floors: o.floors, floorH},
  };
  return b;
}
export const isStyle = (s: string): s is BuildingStyle => (BUILDING_STYLES as readonly string[]).includes(s);

// ───────── 추가·삭제 ─────────
export function addZone(poly: Pt[], use: ZoneUse): string {
  const id = uniqueId('new-zone', 'zone');
  mutateDoc(d => { d.zones.push({id, use, poly: poly.map(p => [p[0], p[1]] as Pt)}); });
  selectObj('zone', id); setMsg(`구역 ${id} 추가 (${use})`);
  return id;
}
export function addAnchor(x: number, z: number): string {
  const id = uniqueId('new-anchor', 'anchor'), kind = ed.anchorKind;
  mutateDoc(d => { d.anchors.push({id, kind, x, z, rot: 0, fixed: false, flattenRadius: 12}); });
  selectObj('anchor', id); setMsg(`앵커 ${id} 추가 (${kind})`);
  return id;
}
export function addBuilding(x: number, z: number): string {
  const id = uniqueId('new-bldg', 'building'), b = makeBuilding(id, x, z, ed.bld);
  mutateDoc(d => { d.buildings.push(b); });
  selectObj('building', id); setMsg(`건물 ${id} 추가 (${b.w}×${b.d}m, ${b.floors}층)`);
  return id;
}
/** 지정한 객체를 지우고 연관 참조를 정리한다. 고정 앵커는 막는다. 성공 여부 */
export function deleteObj(s: SelObj): boolean {
  const d = ed.doc;
  if (!d) return false;
  if (s.kind === 'anchor') {
    const a = d.anchors.find(x => x.id === s.id);
    if (a?.fixed) { setMsg(`고정 앵커 ${s.id} 는 지울 수 없습니다 (속성에서 고정 해제 후)`); return false; }
  }
  let c: Counts = zeroCounts();
  mutateDoc(doc => {
    if (s.kind === 'zone') { doc.zones = doc.zones.filter(z => z.id !== s.id); c = deleteZoneRefs(doc, s.id); }
    else if (s.kind === 'anchor') doc.anchors = doc.anchors.filter(a => a.id !== s.id);
    else if (s.kind === 'building') { doc.buildings = doc.buildings.filter(b => b.id !== s.id); c = deleteBuildingRefs(doc, s.id); }
    else if (s.kind === 'edit') doc.terrain.edits = doc.terrain.edits.filter(e => e.id !== s.id);
  });
  selectObj(null); select(null);
  setMsg(`${s.id} 삭제. ${summarize(c)}`.trim());
  return true;
}
export function deleteZoneVertex(z: ZoneSource, k: number): boolean {
  if (z.poly.length <= 3 || k < 0 || k >= z.poly.length) return false;
  mutateDoc(() => { z.poly.splice(k, 1); });
  return true;
}
export function insertZoneVertex(z: ZoneSource, i: number, p: Pt) { mutateDoc(() => { z.poly.splice(i + 1, 0, p); }); }
export function setNodeKind(id: string, kind: NodeKind) {
  const n = ed.doc?.nodes.find(x => x.id === id);
  if (n && n.kind !== kind) mutateDoc(() => { n.kind = kind; });
}
export const editSummary = (e: TerrainEdit): string => e.kind === 'brush' ? `브러시 ${e.mode} r${e.r} ×${e.strength} (${e.pts.length}점)` : e.kind === 'pad' ? `패드 (${e.x}, ${e.z}) r${e.r}` : `회랑 ${e.roadId}`;
