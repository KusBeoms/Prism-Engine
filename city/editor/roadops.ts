// 도로 기하 도우미: 표본 캐시, 히트 테스트, 정점 삽입·삭제(구간 인덱스 보정). DOM 에 의존하지 않는다.
import {sampleControlPath, type Dense} from '../gen/geom.js';
import {LIMITS, ROAD_CLASS_DEFAULTS, roadWidth, type Pt, type RoadSource} from '../city-schema.js';
import {ed} from './state.js';

const cache = new WeakMap<RoadSource, {ver: number; d: Dense}>();
/** 화면 표시·검사용 조밀 표본(오차 0.5m, 간격 2m). 편집 버전이 바뀌면 다시 계산 */
export function dense(r: RoadSource): Dense {
  const c = cache.get(r);
  if (c && c.ver === ed.ver) return c.d;
  const d = sampleControlPath(r.pts, r.pts.length < 3 ? 'line' : r.curve, 0.5, 2, LIMITS.samplesPerRoad);
  cache.set(r, {ver: ed.ver, d});
  return d;
}
/** 캐시 없이 지금 pts 로 계산한 길이(편집 직후·touched 전에 쓴다) */
export function lengthNow(r: RoadSource): number {
  const d = sampleControlPath(r.pts, r.pts.length < 3 ? 'line' : r.curve, 0.5, 2, LIMITS.samplesPerRoad);
  return d.n ? d.s[d.n - 1] : 0;
}
export function roadLength(r: RoadSource): number { const d = dense(r); return d.n ? d.s[d.n - 1] : 0; }
export function roadWidthM(r: RoadSource): number { return roadWidth({...ROAD_CLASS_DEFAULTS[r.cls], ...(r.lanes ?? {})}); }

export interface Near { d: number; j: number; x: number; z: number }
/** 점에서 도로 표본 꺾은선까지 가장 가까운 지점 */
export function nearest(r: RoadSource, x: number, z: number): Near {
  const d = dense(r);
  let best: Near = {d: Infinity, j: 0, x: 0, z: 0};
  for (let j = 1; j < d.n; j++) {
    const ax = d.x[j - 1], az = d.z[j - 1], bx = d.x[j] - ax, bz = d.z[j] - az;
    const l2 = bx * bx + bz * bz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / l2)) : 0;
    const px = ax + bx * t, pz = az + bz * t, dist = Math.hypot(x - px, z - pz);
    if (dist < best.d) best = {d: dist, j: j - 1, x: px, z: pz};
  }
  return best;
}
/** 월드 좌표 근처의 도로. tol(m) 안에서 가장 가까운 것. 선택된 도로를 우선한다 */
export function hitRoad(x: number, z: number, tol: number): RoadSource | undefined {
  if (!ed.doc) return undefined;
  let best: RoadSource | undefined, bd = tol;
  for (const r of ed.doc.roads) {
    const n = nearest(r, x, z), bias = r.id === ed.selRoad ? -0.3 * tol : 0;
    if (n.d + bias < bd) { bd = n.d + bias; best = r; }
  }
  return best;
}
/** 점 근처의 제어점 인덱스(없으면 -1) */
export function hitVertex(r: RoadSource, x: number, z: number, tol: number): number {
  let bi = -1, bd = tol;
  r.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
/** 표본 인덱스 j 가 속한 제어 구간 번호 i (pts[i]→pts[i+1]) */
export function segIndexAt(r: RoadSource, j: number): number {
  const d = dense(r);
  let i = 0;
  while (i < r.pts.length - 2 && d.ctrl[i + 1] <= j) i++;
  return i;
}
/** pts[i] 와 pts[i+1] 사이(새 인덱스 i+1)에 점을 넣고 segments 의 from/to 를 보정한다 */
export function insertPoint(r: RoadSource, i: number, p: Pt) {
  r.pts.splice(i + 1, 0, p);
  for (const s of r.segments ?? []) { if (s.from > i) s.from++; if (s.to > i) s.to++; }
}
/** 점 k 를 지우고(최소 2점 유지) segments 보정. 지워서 퇴화한 구간은 함께 제거. 성공 여부 반환 */
export function removePoint(r: RoadSource, k: number): boolean {
  if (r.pts.length <= 2 || k < 0 || k >= r.pts.length) return false;
  r.pts.splice(k, 1);
  if (r.segments) {
    for (const s of r.segments) { if (s.from > k) s.from--; if (s.to >= k) s.to--; }
    r.segments = r.segments.filter(s => s.to > s.from);
    if (!r.segments.length) delete r.segments;
  }
  return true;
}
export const round1 = (v: number) => Math.round(v * 10) / 10;
export function uniqueRoadId(base = 'new-road'): string {
  const ids = new Set(ed.doc?.roads.map(r => r.id));
  for (let i = 1; ; i++) { const id = `${base}-${i}`; if (!ids.has(id)) return id; }
}
