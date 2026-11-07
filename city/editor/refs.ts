// 참조 자동 갱신(순수, DOM 없음): 점 이동/삽입/삭제와 객체 삭제 때 nodes.at·nodes.roads·ramps·parcels t0/t1·segments.heights.s·corridor·buildings 참조를 맞춘다.
// 길이가 바뀌면 도로에 매달린 "누적거리" 값(t0/t1, heights.s)은 새 길이/옛 길이 비율로 늘이고 줄인다(근사: 바뀐 점 뒤쪽이 더 많이 밀리지는 않음).
import type {CitySource, Pt, RoadSource} from '../city-schema.js';

/** 노드가 점에 묶였다고 보는 거리(m) */
export const NODE_TIE_M = 0.6;
/** 다른 도로의 점이 같은 자리로 보는 거리(m) */
export const SAME_PT_M = 0.05;
const near = (a: Pt, b: Pt, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

export interface Counts { nodes: number; ramps: number; parcels: number; buildings: number; edits: number; refs: number }
export const zeroCounts = (): Counts => ({nodes: 0, ramps: 0, parcels: 0, buildings: 0, edits: 0, refs: 0});

/** 점 p 와 같은 자리에 있는 (도로 id, 점 인덱스) 목록. 자기 자신 포함 */
export function coincident(doc: CitySource, p: Pt, tol = SAME_PT_M): Array<{road: string; idx: number}> {
  const out: Array<{road: string; idx: number}> = [];
  for (const r of doc.roads) r.pts.forEach((q, i) => { if (near(q, p, tol)) out.push({road: r.id, idx: i}); });
  return out;
}
/** 도로 점 이동에 따라 그 점에 묶인 노드를 따라 움직인다. 옮긴 노드 수 */
export function moveNodesAt(doc: CitySource, roadIds: string[], from: Pt, to: Pt): number {
  let n = 0;
  for (const nd of doc.nodes ?? []) {
    if (near(nd.at, from, NODE_TIE_M) && nd.roads.some(id => roadIds.includes(id))) { nd.at = [to[0], to[1]]; n++; }
  }
  return n;
}
/** 도로 길이가 len0 → len1 로 바뀐 것을 t0/t1·heights.s 에 반영 */
export function rescaleRoad(doc: CitySource, r: RoadSource, len0: number, len1: number): number {
  if (!(len0 > 0) || !(len1 > 0) || Math.abs(len1 - len0) < 1e-6) return 0;
  const f = len1 / len0;
  let n = 0;
  for (const q of doc.parcels ?? []) if (q.road === r.id) { q.t0 = Math.round(q.t0 * f * 100) / 100; q.t1 = Math.round(q.t1 * f * 100) / 100; n++; }
  for (const sg of r.segments ?? []) for (const k of sg.heights ?? []) { k.s = Math.round(k.s * f * 100) / 100; n++; }
  return n;
}
/** 노드 삭제 + 그 노드를 쓰는 램프·noTurn 정리 */
export function dropNode(doc: CitySource, id: string, c: Counts) {
  const before = doc.nodes.length;
  doc.nodes = doc.nodes.filter(n => n.id !== id);
  c.nodes += before - doc.nodes.length;
  const rb = doc.ramps.length;
  doc.ramps = doc.ramps.filter(r => r.fromNode !== id && r.toNode !== id);
  c.ramps += rb - doc.ramps.length;
  for (const r of doc.roads) for (const s of r.segments ?? []) if (s.noTurn?.includes(id)) { s.noTurn = s.noTurn.filter(x => x !== id); if (!s.noTurn.length) delete s.noTurn; c.refs++; }
}
/** 도로 한 점을 지울 때: 그 점에 묶인 노드에서 이 도로를 뺀다(빈 노드는 삭제) */
export function detachPointRefs(doc: CitySource, road: RoadSource, k: number): Counts {
  const c = zeroCounts(), p = road.pts[k];
  for (const nd of [...(doc.nodes ?? [])]) {
    if (!near(nd.at, p, NODE_TIE_M) || !nd.roads.includes(road.id)) continue;
    nd.roads = nd.roads.filter(x => x !== road.id); c.refs++;
    if (!nd.roads.length) dropNode(doc, nd.id, c);
  }
  return c;
}
/** 도로 삭제에 따른 모든 참조 정리 */
export function deleteRoadRefs(doc: CitySource, id: string): Counts {
  const c = zeroCounts();
  for (const nd of [...(doc.nodes ?? [])]) {
    if (!nd.roads.includes(id)) continue;
    nd.roads = nd.roads.filter(x => x !== id); c.refs++;
    if (!nd.roads.length) dropNode(doc, nd.id, c);
  }
  const rb = doc.ramps.length;
  doc.ramps = doc.ramps.filter(r => r.road !== id);
  c.ramps += rb - doc.ramps.length;
  const gone = new Set(doc.parcels.filter(p => p.road === id).map(p => p.id));
  doc.parcels = doc.parcels.filter(p => p.road !== id); c.parcels += gone.size;
  for (const b of doc.buildings) if (b.parcel && gone.has(b.parcel)) { delete b.parcel; c.refs++; }
  for (const s of doc.parking ?? []) if (s.road === id) { delete s.road; c.refs++; }
  const eb = doc.terrain.edits.length;
  doc.terrain.edits = doc.terrain.edits.filter(e => !(e.kind === 'corridor' && e.roadId === id)); c.edits += eb - doc.terrain.edits.length;
  return c;
}
export function deleteZoneRefs(doc: CitySource, id: string): Counts {
  const c = zeroCounts();
  for (const p of doc.parcels) if (p.zone === id) { delete p.zone; c.refs++; }
  const gb = doc.greenery.length;
  doc.greenery = doc.greenery.filter(g => {
    if (g.zone !== id) return true;
    if (g.roadClass || g.zoneUse) { delete g.zone; c.refs++; return true; }
    return false; // 구역에만 걸린 규칙은 대상이 없어짐
  });
  c.refs += gb - doc.greenery.length;
  return c;
}
export function deleteBuildingRefs(doc: CitySource, id: string): Counts {
  const c = zeroCounts(), eb = doc.exceptions.length;
  doc.exceptions = doc.exceptions.filter(e => !((e.kind === 'fixed' || e.kind === 'style') && e.target === id));
  c.refs += eb - doc.exceptions.length;
  return c;
}
export const summarize = (c: Counts): string => {
  const p: string[] = [];
  if (c.nodes) p.push(`노드 ${c.nodes}`); if (c.ramps) p.push(`램프 ${c.ramps}`); if (c.parcels) p.push(`필지 ${c.parcels}`);
  if (c.edits) p.push(`회랑 ${c.edits}`); if (c.refs) p.push(`참조 ${c.refs}`);
  return p.length ? `연관 정리: ${p.join(', ')}` : '';
};
