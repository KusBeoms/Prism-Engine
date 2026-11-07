// 검증 확장(순수 검사): 시선 축 침범, 건물 겹침·경계·도로 침범, ID 교차 중복, 도로 연결성, 도로 경사 한도.
// 입력이 깨져 있어도 던지지 않도록 모든 배열은 방어적으로 읽는다(깨진 값은 스키마 검증이 따로 보고).
import {pointBlocks, sightAxesOf} from '../gen/sight.js';
import {SCALE, type BuildingSource, type CitySource, type Pt, type RoadSource} from '../city-schema.js';
import {bldCorners, bldOverlap, bldObb, pointInPoly} from './objops.js';
import {distToObb} from '../gen/obb.js';
import {nearest, roadWidthM} from './roadops.js';
import type {Issue} from './state.js';
import {allGradeHits, heightAt} from './terrain-ed.js';

const TOUCH_M = 2;
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const okPt = (p: unknown): p is Pt => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const goodBld = (b: BuildingSource) => b && Number.isFinite(b.x) && Number.isFinite(b.z) && b.w > 0 && b.d > 0 && Number.isFinite(b.rot);

export function sightIssues(doc: CitySource): Issue[] {
  const out: Issue[] = [], bs = arr<BuildingSource>(doc.buildings).filter(goodBld);
  if (!bs.length || !arr(doc.anchors).length) return out;
  const axes = sightAxesOf(doc);
  for (const b of bs) {
    const g = b.groundY ?? heightAt(b.x, b.z) ?? 0, top = g + b.floors * (SCALE.floorH[b.style] ?? 3.8);
    const cs = bldCorners(b), pts: Pt[] = [[b.x, b.z], ...cs];
    for (const a of axes) {
      const eye = (a.y ?? heightAt(a.x, a.z) ?? 0) + a.eye;
      if (pts.some(p => pointBlocks(a, eye, p[0], p[1], top))) { out.push({sev: 'error', code: 'sight-block', msg: `${b.id}: 사과 시선 축(${a.id}, 정북 ±${a.halfDeg}°, 고도 ${a.elevDeg}°)을 가림 — 지붕 해발 ${top.toFixed(1)}m`, at: [b.x, b.z]}); break; }
    }
  }
  return out;
}
export function buildingIssues(doc: CitySource): Issue[] {
  const out: Issue[] = [], bs = arr<BuildingSource>(doc.buildings).filter(goodBld);
  const bounds = arr<Pt>(doc.bounds).filter(okPt);
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    for (let j = i + 1; j < bs.length; j++) if (bldOverlap(a, bs[j])) out.push({sev: 'error', code: 'building-overlap', msg: `${a.id} 와 ${bs[j].id} 의 발자국이 겹침`, at: [a.x, a.z]});
    if (bounds.length >= 3 && !pointInPoly(a.x, a.z, bounds)) out.push({sev: 'warn', code: 'building-outside-bounds', msg: `${a.id}: 건축 가능 경계 밖`, at: [a.x, a.z]});
    const o = bldObb(a);
    for (const r of arr<RoadSource>(doc.roads)) {
      if (!Array.isArray(r.pts) || r.pts.length < 2 || !r.pts.every(okPt)) continue;
      const half = roadWidthM(r) / 2, n = nearest(r, a.x, a.z);
      if (n.d > half + Math.hypot(o.hw, o.hd) + 1) continue;
      if (distToObb(o, n.x, n.z) < half) { out.push({sev: 'warn', code: 'building-on-road', msg: `${a.id}: 도로 ${r.id} 폭(${half.toFixed(1)}m 반폭)에 걸침`, road: r.id, at: [a.x, a.z]}); break; }
    }
    for (const e of arr<any>(doc.exceptions)) if (e?.kind === 'noBuild' && arr(e.poly).length >= 3 && pointInPoly(a.x, a.z, e.poly)) out.push({sev: 'warn', code: 'building-in-nobuild', msg: `${a.id}: 건축 금지 구역 ${e.id} 안`, at: [a.x, a.z]});
  }
  return out;
}
/** 컬렉션이 달라도 같은 ID 를 쓰면(예외 target·참조가 모호해짐) 경고. 같은 컬렉션 중복은 스키마 검증이 오류로 보고 */
export function crossIdIssues(doc: CitySource): Issue[] {
  const seen = new Map<string, string>(), out: Issue[] = [];
  for (const k of ['roads', 'nodes', 'zones', 'anchors', 'buildings', 'parcels', 'ramps'] as const) {
    const local = new Set<string>();
    for (const o of arr<{id?: string}>((doc as any)[k])) {
      const id = o?.id;
      if (typeof id !== 'string' || local.has(id)) continue;
      local.add(id);
      const prev = seen.get(id);
      if (prev && prev !== k) out.push({sev: 'warn', code: 'dup-id-cross', msg: `ID "${id}" 가 ${prev} 와 ${k} 에 모두 있음`});
      else seen.set(id, k);
    }
  }
  return out;
}
/** 도로망 연결성: 노드 공유·램프·끝점 접촉(2m)으로 묶고, 가장 큰 덩어리 밖의 묶음을 알린다 */
export function connectivityIssues(doc: CitySource): Issue[] {
  const roads = arr<RoadSource>(doc.roads).filter(r => r && Array.isArray(r.pts) && r.pts.length >= 2 && r.pts.every(okPt));
  if (roads.length < 2) return [];
  const idx = new Map(roads.map((r, i) => [r.id, i])), par = roads.map((_, i) => i);
  const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const uni = (a: number, b: number) => { par[find(a)] = find(b); };
  const nodes = new Map(arr<any>(doc.nodes).map(n => [n?.id, n]));
  for (const n of nodes.values()) { const ids = arr<string>(n?.roads).map(id => idx.get(id)).filter((v): v is number => v !== undefined); for (let k = 1; k < ids.length; k++) uni(ids[0], ids[k]); }
  for (const rp of arr<any>(doc.ramps)) {
    const a = idx.get(rp?.road);
    if (a === undefined) continue;
    for (const nid of [rp.fromNode, rp.toNode]) for (const id of arr<string>(nodes.get(nid)?.roads)) { const b = idx.get(id); if (b !== undefined) uni(a, b); }
  }
  roads.forEach((r, i) => {
    for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) {
      roads.forEach((o, j) => { if (j !== i && find(i) !== find(j) && nearest(o, p[0], p[1]).d <= TOUCH_M) uni(i, j); });
    }
  });
  const groups = new Map<number, RoadSource[]>();
  roads.forEach((r, i) => { const g = find(i); (groups.get(g) ?? groups.set(g, []).get(g)!).push(r); });
  const gs = [...groups.values()].sort((a, b) => b.length - a.length);
  const out: Issue[] = [];
  for (const g of gs.slice(1, 21)) {
    const ids = g.map(r => r.id);
    out.push({sev: 'warn', code: 'disconnected', msg: `도로 ${g.length}개 묶음이 본 도로망(${gs[0].length}개)과 이어지지 않음: ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ' …' : ''}`, road: ids[0], at: g[0].pts[0]});
  }
  return out;
}
export function gradeIssues(): Issue[] {
  return allGradeHits().slice(0, 60).map(h => ({sev: 'warn' as const, code: 'road-grade', msg: `${h.road}: 구간 ${h.s0.toFixed(0)}~${h.s1.toFixed(0)}m 경사 ${(h.grade * 100).toFixed(1)}% > 한도 ${(h.limit * 100).toFixed(0)}% (지형 기준 추정, 절토·성토 전)`, road: h.road, at: [h.x, h.z] as Pt}));
}
export function runExtra(doc: CitySource): Issue[] {
  const out: Issue[] = [];
  for (const f of [sightIssues, buildingIssues, crossIdIssues, connectivityIssues]) { try { out.push(...f(doc)); } catch (e) { out.push({sev: 'warn', code: 'check-failed', msg: `${f.name} 검사 실패: ${(e as Error).message}`}); } }
  try { out.push(...gradeIssues()); } catch { /* 지형 없음 */ }
  return out;
}
