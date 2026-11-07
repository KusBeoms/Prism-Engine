// 교차로 형상: 포장 다각형(모서리 반경, 예각 마이터 한계), 팔 트림 거리, 보도 모서리 띠, 연석선, 횡단보도·정지선, 회전교차로 링.
// 팔은 노드 부근에서 직선이라고 가정한다. 규칙은 CITYGEN.md 의 "교차로" 절. 좌표 x(동+) z(남+), p = 팔 방향 u 의 오른쪽 법선 (-uz, ux).
import {SCALE} from '../city-schema.js';
import {lineIntersect, signedArea, triangulatePolygon, wrapPi} from './geom.js';
import type {P2} from './geom.js';
import {pointAt} from './roads.js';
import type {RoadGeo} from './roads.js';
import type {Arm, Cluster} from './junctions.js';

export type V3 = [number, number, number];
export interface Band { inner: V3[]; outer: V3[] }
export interface JunctionGeom {
  id: string; kind: string; layer: number; x: number; y: number; z: number;
  /** 포장 외곽선(회전교차로는 팔 입구 현 포함 바깥 경계) */
  polygon: P2[];
  /** 포장 삼각형 xyz*3 */
  pave: number[];
  bands: Band[];
  island?: {cx: number; cz: number; r: number; y: number};
  crosswalks: V3[][];
  stops: V3[][];
  arms: {roadId: string; dir: 1 | -1; sNode: number; trim: number}[];
  passThrough: boolean;
  /** 보고: 팔 높이 불일치 최대(m), 삼각분할 방식 */
  dyMax: number; fan: boolean;
  warnings: string[];
}
export const T_MAX = 60;
const MIN_TRIM = 0.5;
const radiusOf = (c: Arm['cls']): number => (c === 'local' ? 6 : c === 'collector' ? 8 : c === 'expressway' ? 15 : 12);
const P = (a: Arm): P2 => [-a.uz, a.ux];
const yAt = (r: RoadGeo, a: Arm, t: number): number => pointAt(r, Math.min(Math.max(a.sNode + a.dir * t, 0), r.length)).y;
const edge = (a: Arm, side: 1 | -1, t: number): P2 => { const p = P(a), w = side === 1 ? a.wP : -a.wM; return [a.ox + w * p[0] + t * a.ux, a.oz + w * p[1] + t * a.uz]; };

type Corner = {type: 'fillet' | 'miter' | 'chord' | 'arc'; t1: number; t2: number; tau: number};

function cornerInfo(a: Arm, b: Arm, phi: number): Corner {
  const pa = P(a), pb = P(b);
  const o1: P2 = [a.ox + a.wP * pa[0], a.oz + a.wP * pa[1]], o2: P2 = [b.ox - b.wM * pb[0], b.oz - b.wM * pb[1]];
  const hit = lineIntersect(o1, [a.ux, a.uz], o2, [b.ux, b.uz]);
  if (Math.abs(phi - Math.PI) < 0.05 || !hit || hit.t < -1 || hit.u < -1 || hit.t > T_MAX || hit.u > T_MAX) return {type: 'chord', t1: 0, t2: 0, tau: 0};
  const t1 = Math.max(hit.t, 0), t2 = Math.max(hit.u, 0);
  if (phi > Math.PI) return {type: 'miter', t1, t2, tau: 0};
  const r = Math.max(radiusOf(a.cls), radiusOf(b.cls)), tau = Math.min(r / Math.tan(phi / 2), 1.6 * r);
  return {type: 'fillet', t1, t2, tau};
}
const bez = (a: V3, c: P2, b: V3, m: number): V3[] => {
  const out: V3[] = [];
  for (let j = 1; j <= m; j++) {
    const t = j / (m + 1), u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], a[1] + (b[1] - a[1]) * t, u * u * a[2] + 2 * u * t * c[1] + t * t * b[2]]);
  }
  return out;
};
const lin = (a: V3, b: V3, m: number): V3[] => { const o: V3[] = []; for (let j = 1; j <= m; j++) { const t = j / (m + 1); o.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); } return o; };
const BEZ_M = 8;

export function buildJunction(cl: Cluster, roads: RoadGeo[], opts: {crosswalks: boolean} = {crosswalks: true}): JunctionGeom {
  const arms = cl.arms, n = arms.length;
  const g: JunctionGeom = {id: cl.id, kind: cl.kind, layer: cl.layer, x: cl.x, y: cl.y, z: cl.z, polygon: [], pave: [], bands: [], crosswalks: [], stops: [], arms: [], passThrough: false, dyMax: 0, fan: true, warnings: []};
  const distinct = new Set(arms.map(a => a.ri)).size;
  const round = cl.kind === 'roundabout' && n >= 2;
  g.passThrough = !round && (n < 2 || distinct < 2);
  const sortedOut = () => { g.arms = arms.map(a => ({roadId: a.roadId, dir: a.dir, sNode: a.sNode, trim: a.trim})); };
  if (g.passThrough) {
    arms.forEach(a => { a.trim = 0; });
    sortedOut();
    if (cl.kind === 'signal' && opts.crosswalks) arms.forEach(a => addCrosswalk(g, roads[a.ri], a, 0));
    return g;
  }
  const px = arms.reduce((s, a) => s + a.ox, 0) / n, pz = arms.reduce((s, a) => s + a.oz, 0) / n;
  const phis: number[] = arms.map((a, k) => { const nx = arms[(k + 1) % n]; let d = wrapPi(nx.angle - a.angle); if (d <= 1e-6) d += 2 * Math.PI; return n === 1 ? 2 * Math.PI : d; });
  const need = arms.map(() => MIN_TRIM);
  let corners: Corner[] = [];
  let ro = 0;
  if (round) {
    let wmax = 0;
    for (const a of arms) wmax = Math.max(wmax, a.wP, a.wM);
    ro = Math.max(13, wmax + 4);
    arms.forEach((a, k) => {
      const p = P(a);
      let t = 0;
      for (const side of [1, -1]) {
        const w = side === 1 ? a.wP : -a.wM, wx = a.ox + w * p[0] - cl.x, wz = a.oz + w * p[1] - cl.z, dot = wx * a.ux + wz * a.uz, disc = dot * dot - (wx * wx + wz * wz) + ro * ro;
        t = Math.max(t, disc > 0 ? -dot + Math.sqrt(disc) : 0);
      }
      need[k] = Math.max(MIN_TRIM, t);
    });
    corners = arms.map(() => ({type: 'arc' as const, t1: 0, t2: 0, tau: 0}));
  } else {
    corners = arms.map((a, k) => {
      const c = cornerInfo(a, arms[(k + 1) % n], phis[k]);
      const nxi = (k + 1) % n;
      if (c.type === 'fillet') { need[k] = Math.max(need[k], c.t1 + c.tau); need[nxi] = Math.max(need[nxi], c.t2 + c.tau); }
      else if (c.type === 'miter') { need[k] = Math.max(need[k], c.t1); need[nxi] = Math.max(need[nxi], c.t2); }
      return c;
    });
  }
  arms.forEach((a, k) => { a.trim = Math.min(need[k], T_MAX); if (need[k] > T_MAX) g.warnings.push(`팔 ${a.roadId} 트림이 상한 ${T_MAX}m 를 넘어 잘렸다 (예각)`); });
  // 꼭짓점·모서리 곡선
  const A = arms.map((a, k) => { const e = edge(a, 1, a.trim); return [e[0], yAt(roads[a.ri], a, a.trim), e[1]] as V3; });
  const B = arms.map((a, k) => { const e = edge(a, -1, a.trim); return [e[0], yAt(roads[a.ri], a, a.trim), e[1]] as V3; });
  const inner: V3[][] = [], outer: (V3[] | null)[] = [];
  const poly3: V3[] = [];
  arms.forEach((a, k) => {
    const nx = (k + 1) % n, b = arms[nx], c = corners[k];
    poly3.push(B[k], A[k]);
    let inn: V3[] = [A[k], B[nx]], out: V3[] | null = null;
    const w1 = a.walkP, w2 = b.walkM, pa = P(a), pb = P(b);
    const E: V3 = [A[k][0] + w1 * pa[0], A[k][1], A[k][2] + w1 * pa[1]], F: V3 = [B[nx][0] - w2 * pb[0], B[nx][1], B[nx][2] - w2 * pb[1]];
    const hasBand = w1 > 0.01 && w2 > 0.01 && n > 1;
    const o1: P2 = [a.ox + a.wP * pa[0], a.oz + a.wP * pa[1]], o2: P2 = [b.ox - b.wM * pb[0], b.oz - b.wM * pb[1]];
    if (c.type === 'arc') {
      const th = (v: V3, o: P2) => Math.atan2(v[2] - o[1], v[0] - o[0]);
      const ring = (s: V3, e: V3): V3[] => {
        const t0 = th(s, [cl.x, cl.z]);
        let t1 = th(e, [cl.x, cl.z]); while (t1 <= t0) t1 += 2 * Math.PI;
        if (t1 - t0 > Math.PI * 1.5) t1 = t0; // 팔이 하나뿐인 경우 등: 호 없음
        const m = Math.max(1, Math.ceil((t1 - t0) / 0.18)) - 1, r0 = Math.hypot(s[0] - cl.x, s[2] - cl.z), r1 = Math.hypot(e[0] - cl.x, e[2] - cl.z);
        const o: V3[] = [];
        for (let j = 1; j <= m; j++) { const f = j / (m + 1), ang = t0 + (t1 - t0) * f, r = r0 + (r1 - r0) * f; o.push([cl.x + r * Math.cos(ang), s[1] + (e[1] - s[1]) * f, cl.z + r * Math.sin(ang)]); }
        return o;
      };
      const mid = ring(A[k], B[nx]);
      inn = [A[k], ...mid, B[nx]];
      if (hasBand) {
        const t0 = th(E, [cl.x, cl.z]);
        let t1 = th(F, [cl.x, cl.z]); while (t1 <= t0) t1 += 2 * Math.PI;
        const m = mid.length, r0 = Math.hypot(E[0] - cl.x, E[2] - cl.z), r1 = Math.hypot(F[0] - cl.x, F[2] - cl.z), o: V3[] = [E];
        for (let j = 1; j <= m; j++) { const f = j / (m + 1), ang = t0 + (t1 - t0) * f, r = r0 + (r1 - r0) * f; o.push([cl.x + r * Math.cos(ang), mid[j - 1][1], cl.z + r * Math.sin(ang)]); }
        o.push(F); out = o;
      }
      poly3.push(...mid);
    } else if (c.type !== 'chord' && a.trim >= c.t1 - 1e-6 && b.trim >= c.t2 - 1e-6) {
      const C: P2 = [o1[0] + c.t1 * a.ux, o1[1] + c.t1 * a.uz];
      if (c.type === 'fillet') {
        const mid = bez(A[k], C, B[nx], BEZ_M);
        inn = [A[k], ...mid, B[nx]];
        poly3.push(...mid);
      } else { const cy = (A[k][1] + B[nx][1]) / 2; inn = [A[k], [C[0], cy, C[1]], B[nx]]; poly3.push(inn[1]); }
      if (hasBand) {
        const h = lineIntersect([o1[0] + w1 * pa[0], o1[1] + w1 * pa[1]], [a.ux, a.uz], [o2[0] - w2 * pb[0], o2[1] - w2 * pb[1]], [b.ux, b.uz]);
        if (h && h.t >= 0 && h.u >= 0 && h.t < T_MAX * 1.5) {
          const Co: P2 = [o1[0] + w1 * pa[0] + h.t * a.ux, o1[1] + w1 * pa[1] + h.t * a.uz];
          out = c.type === 'fillet' ? [E, ...bez(E, Co, F, BEZ_M), F] : [E, [Co[0], inn[1][1], Co[1]], F];
        } else out = [E, ...lin(E, F, inn.length - 2), F];
      }
    } else if (hasBand) out = [E, F];
    inner.push(inn); outer.push(out);
  });
  // 팔 입구 현이 모서리 곡선의 시작점에서 어긋나지 않게 outer 길이를 inner 와 맞춘다
  g.polygon = poly3.map(v => [v[0], v[2]] as P2);
  if (Math.abs(signedArea(g.polygon)) < 1e-3) { g.warnings.push('교차로 다각형 면적이 0'); g.passThrough = true; sortedOut(); return g; }
  inner.forEach((inn, k) => { const o = outer[k]; if (o && o.length === inn.length) g.bands.push({inner: inn, outer: o}); else if (o) g.bands.push({inner: [inn[0], inn[inn.length - 1]], outer: [o[0], o[o.length - 1]]}); });
  // 포장 삼각분할
  const cy = cl.y;
  if (round) {
    const Ri = ro - 7.5, ni = Math.max(24, Math.ceil(2 * Math.PI * Ri / 2.5)), ring: V3[] = [];
    for (let j = 0; j < ni; j++) { const ang = (2 * Math.PI * j) / ni; ring.push([cl.x + Ri * Math.cos(ang), cy, cl.z + Ri * Math.sin(ang)]); }
    g.island = {cx: cl.x, cz: cl.z, r: Ri, y: cy};
    ringTris(g.pave, poly3, ring, cl.x, cl.z);
  } else {
    const c: V3 = [px, cy, pz];
    let ok = true; const s0 = Math.sign(signedArea(g.polygon));
    for (let i = 0; i < poly3.length && ok; i++) { const a = poly3[i], b = poly3[(i + 1) % poly3.length]; const ar = ((a[0] - px) * (b[2] - pz) - (b[0] - px) * (a[2] - pz)) / 2; if (ar * s0 < -1e-9) ok = false; }
    g.fan = ok;
    if (ok) for (let i = 0; i < poly3.length; i++) pushTri(g.pave, c, poly3[i], poly3[(i + 1) % poly3.length]);
    else { const idx = triangulatePolygon(g.polygon); for (let i = 0; i < idx.length; i += 3) pushTri(g.pave, poly3[idx[i]], poly3[idx[i + 1]], poly3[idx[i + 2]]); }
  }
  for (const a of arms) g.dyMax = Math.max(g.dyMax, Math.abs(a.oy - cl.y));
  if (cl.kind === 'signal' && opts.crosswalks) arms.forEach(a => addCrosswalk(g, roads[a.ri], a, a.trim));
  sortedOut();
  return g;
}
function pushTri(out: number[], a: V3, b: V3, c: V3): void { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }

/** 바깥 경계(각도 오름차순, 중심 기준)와 안쪽 원 사이 고리를 두 포인터로 이어 삼각형을 만든다 */
function ringTris(out: number[], outer: V3[], inner: V3[], cx: number, cz: number): void {
  const ang = (v: V3) => Math.atan2(v[2] - cz, v[0] - cx);
  const a0 = ang(outer[0]), unwrap = (arr: V3[], base: number): number[] => { const r: number[] = []; let prev = base; arr.forEach((v, i) => { let t = ang(v); while (t < prev - 1e-9) t += 2 * Math.PI; if (i === 0) t = base; r.push(t); prev = t; }); return r; };
  const to = unwrap(outer, a0);
  const ti = inner.map((v, j) => { let t = ang(v); while (t < a0) t += 2 * Math.PI; return [t, j] as [number, number]; }).sort((p, q) => p[0] - q[0]).map(p => p[1]);
  const inn: V3[] = ti.map(j => inner[j]), tin = ti.map(j => { let t = ang(inner[j]); while (t < a0) t += 2 * Math.PI; return t; });
  let i = 0, j = 0;
  const no = outer.length, ni = inn.length;
  while (i < no || j < ni) {
    const nextO = i < no ? (i + 1 < no ? to[i + 1] : a0 + 2 * Math.PI) : Infinity, nextI = j < ni ? (j + 1 < ni ? tin[j + 1] : a0 + 2 * Math.PI) : Infinity;
    if (i >= no && j >= ni) break;
    if (i < no && (nextO <= nextI || j >= ni)) { pushTri(out, outer[i], outer[(i + 1) % no], inn[j % ni]); i++; }
    else { pushTri(out, outer[i % no], inn[(j + 1) % ni], inn[j % ni]); j++; }
  }
}

/** 횡단보도(제브라 줄무늬)와 정지선. 팔 트림 바깥에 놓는다 */
function addCrosswalk(g: JunctionGeom, r: RoadGeo, a: Arm, trim: number): void {
  if (a.walkP < 0.01 && a.walkM < 0.01) return;
  const p = P(a), t0 = trim + 0.5, t1 = t0 + SCALE.crosswalkW, stopT = t1 + 1.5;
  const at = (l: number, t: number): V3 => { const q = pointAt(r, Math.min(Math.max(a.sNode + a.dir * t, 0), r.length)); return [a.ox + l * p[0] + t * a.ux, q.y + 0.015, a.oz + l * p[1] + t * a.uz]; };
  for (let l = -a.wM + 0.5; l + 0.5 <= a.wP - 0.4; l += 1.0) g.crosswalks.push([at(l, t0), at(l + 0.5, t0), at(l + 0.5, t1), at(l, t1)]);
  if (a.oneWay && a.dir === 1) return; // 일방통행 도로가 노드에서 멀어지는 팔 → 진입 차량 없음
  const lo = a.oneWay ? -a.wM : -a.lM1, hi = a.oneWay ? a.wP : -a.lM0;
  g.stops.push([at(lo, stopT), at(hi, stopT), at(hi, stopT + 0.4), at(lo, stopT + 0.4)]);
}
