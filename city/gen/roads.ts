// 도로 해석: RoadSource → 조밀 표본(전역 s·좌표·종단·단면·구간). 순수. 단면은 구간별 덮어쓰기를 부드럽게 전이한다.
import {LIMITS, ROAD_CLASS_DEFAULTS, SCALE} from '../city-schema.js';
import type {Layer, RoadProfile, RoadSegment, RoadSource, SegKind} from '../city-schema.js';
import type {CompiledRoad, RoadSample} from '../city-compiled.js';
import {curvatures, lerp, smooth01, sampleControlPath, tangents, wrapPi} from './geom.js';
import {gradeViolation, gradesOf, keyY, solveProfile} from './road-profile.js';
import {rnd} from './bytes.js';
import {sampleBilinear} from './terrain.js';
import type {Terrain} from './terrain.js';

export interface Rej { owner: string; code: string; msg: string }
export interface BuildOpts {
  /** 조밀 표본 간격(m) */
  step: number;
  /** 단면 전이 길이(m) */
  sectionBlend: number;
  /** 지형 추종 구간 허용 절토·성토 깊이(m) */
  maxEarthwork: number;
}
export const DEFAULT_ROAD_OPTS: BuildOpts = {step: LIMITS.sampleStep, sectionBlend: 12, maxEarthwork: 10};

export const KIND_CODE: Record<SegKind, number> = {ground: 0, bridge: 1, tunnel: 2, ramp: 3};
/** 단면 배열 한 표본의 필드 순서 */
export const SEC = {med: 0, lanesW: 1, lanesN: 2, parkL: 3, parkR: 4, shoulder: 5, walk: 6, plant: 7, oneWay: 8, N: 9} as const;
export const MEDIAN_RAISED_MIN = 1.0;

export interface SegGeo {
  id: string; i0: number; i1: number; s0: number; s1: number;
  layer: Layer; kind: SegKind; explicit: boolean; keys: {s: number; y: number}[];
  sec: number[]; oneWay: boolean;
}
export interface RoadGeo {
  id: string; cls: RoadSource['cls']; src: RoadSource;
  n: number; length: number;
  s: Float64Array; x: Float64Array; z: Float64Array; y: Float64Array; tx: Float64Array; tz: Float64Array;
  grade: Float64Array; kappa: Float64Array;
  /** 표본마다 N 개씩 이어 붙인 단면 */
  sec: Float64Array;
  segIdx: Uint16Array;
  segs: SegGeo[];
  maxGrade: number;
  ctrl: number[];
  limitedLen: number; earthwork: number;
}
/** 한쪽 가장자리 누적 거리 (중심에서 바깥으로). e0 중앙분리대 가장자리 → e1 차로 끝 → e2 주차대 끝 → e3 갓길 끝(포장 끝) → e4 보도 끝 → e5 식재대 끝 */
export interface Edges { e0: number; e1: number; e2: number; e3: number; e4: number; e5: number }
export function sideEdges(sec: ArrayLike<number>, o: number, right: boolean): Edges {
  const one = sec[o + SEC.oneWay] > 0.5;
  const lanesW = sec[o + SEC.lanesW];
  const e0 = one ? 0 : sec[o + SEC.med] / 2, e1 = one ? Math.max(3.5, lanesW) / 2 : e0 + lanesW;
  const e2 = e1 + (right ? sec[o + SEC.parkR] : sec[o + SEC.parkL]), e3 = e2 + sec[o + SEC.shoulder], e4 = e3 + sec[o + SEC.walk];
  return {e0, e1, e2, e3, e4, e5: e4 + sec[o + SEC.plant]};
}

function mergedProfile(src: RoadSource, seg?: RoadSegment): RoadProfile {
  return {...ROAD_CLASS_DEFAULTS[src.cls], ...(src.lanes ?? {}), ...(seg?.lanes ?? {})};
}
function secOf(p: RoadProfile, oneWay: boolean): number[] {
  const a = new Array<number>(SEC.N).fill(0);
  a[SEC.med] = oneWay ? 0 : p.median; a[SEC.lanesW] = p.lanes * p.laneW; a[SEC.lanesN] = oneWay ? p.lanes : p.lanes;
  a[SEC.parkL] = p.parkL; a[SEC.parkR] = p.parkR; a[SEC.shoulder] = p.shoulder; a[SEC.walk] = p.walk; a[SEC.plant] = p.plant; a[SEC.oneWay] = oneWay ? 1 : 0;
  return a;
}

/** 구간 목록 해석: 정렬, 빈틈은 지상 기본 구간으로 채움. 겹침은 거부 */
function resolveSegments(src: RoadSource, ctrl: number[], n: number): {segs: SegGeo[]; err?: string} {
  const list: RoadSegment[] = src.segments && src.segments.length ? src.segments.slice().sort((a, b) => a.from - b.from) : [{id: `${src.id}#0`, from: 0, to: src.pts.length - 1, layer: 0, kind: 'ground'}];
  const out: SegGeo[] = [];
  let cur = 0;
  const push = (id: string, from: number, to: number, seg?: RoadSegment) => {
    const p = mergedProfile(src, seg), one = seg?.oneWay ?? src.oneWay ?? false;
    out.push({id, i0: ctrl[from], i1: ctrl[to], s0: 0, s1: 0, layer: seg?.layer ?? 0, kind: seg?.kind ?? 'ground', explicit: !!seg?.heights && seg.heights.length > 0,
      keys: seg?.heights ?? [], sec: secOf(p, one), oneWay: one});
  };
  for (const g of list) {
    if (g.from < cur) return {segs: out, err: `구간 ${g.id} 가 앞 구간과 겹친다`};
    if (g.to >= ctrl.length || g.from < 0) return {segs: out, err: `구간 ${g.id} 의 제어점 인덱스가 범위를 벗어났다`};
    if (g.from > cur) push(`${src.id}~gap${cur}`, cur, g.from);
    push(g.id, g.from, g.to, g);
    cur = g.to;
  }
  if (cur < ctrl.length - 1) push(`${src.id}~gap${cur}`, cur, ctrl.length - 1);
  out[out.length - 1].i1 = n - 1;
  return {segs: out};
}

export function resolveRoad(src: RoadSource, terrain: Terrain, o: BuildOpts = DEFAULT_ROAD_OPTS): {road?: RoadGeo; rejected: Rej[]; warnings: Rej[]} {
  const rejected: Rej[] = [], warnings: Rej[] = [];
  const d = sampleControlPath(src.pts, src.curve, LIMITS.curveMaxErr, o.step, LIMITS.samplesPerRoad);
  if (d.capped) warnings.push({owner: src.id, code: 'sample-cap', msg: `표본 수 상한(${LIMITS.samplesPerRoad})에 걸려 간격을 늘렸다`});
  const n = d.n, rs = resolveSegments(src, d.ctrl, n);
  if (rs.err) return {rejected: [{owner: src.id, code: 'segment-overlap', msg: rs.err}], warnings};
  const segs = rs.segs;
  segs.forEach(g => { g.s0 = d.s[g.i0]; g.s1 = d.s[g.i1]; });
  const segIdx = new Uint16Array(n);
  segs.forEach((g, k) => { for (let i = g.i0; i <= g.i1; i++) segIdx[i] = k; });
  segs.forEach((g, k) => { if (k > 0) segIdx[g.i0] = k; });
  const {tx, tz} = tangents(d.x, d.z);
  const kappa = curvatures(d.x, d.z, d.s, tx, tz, 6);
  // 종단
  const cp = ROAD_CLASS_DEFAULTS[src.cls];
  const mode = new Uint8Array(n), fixedY = new Float64Array(n), terrainY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = segs[segIdx[i]];
    terrainY[i] = sampleBilinear(terrain, d.x[i], d.z[i]);
    if (g.explicit) { mode[i] = 1; fixedY[i] = keyY(g.keys, d.s[i]); } else mode[i] = g.kind === 'ground' ? 0 : 2;
  }
  const prof = solveProfile({s: d.s, mode, fixedY, terrainY, maxGrade: cp.maxGrade, terrainWin: src.cls === 'expressway' ? 80 : src.cls === 'local' || src.cls === 'collector' ? 30 : 50, curveWin: 16});
  const grade = gradesOf(d.s, prof.y);
  const gv = gradeViolation(d.s, grade, cp.maxGrade);
  if (gv) rejected.push({owner: src.id, code: 'grade-exceeded', msg: `종단 경사 ${(Math.abs(gv.grade) * 100).toFixed(1)}% 가 ${src.cls} 한도 ${(cp.maxGrade * 100).toFixed(0)}% 를 넘는다 (s=${gv.s.toFixed(0)}m). 제어점·높이 키를 조정하거나 우회하라`});
  if (prof.earthwork > o.maxEarthwork) rejected.push({owner: src.id, code: 'earthwork-exceeded', msg: `지형을 따르려면 절토·성토 ${prof.earthwork.toFixed(1)}m 가 필요하다 (한도 ${o.maxEarthwork}m). 경사 한도 때문에 도로가 지형에서 너무 멀어진다`});
  if (rejected.length) return {rejected, warnings};
  if (prof.limitedLen > 0) warnings.push({owner: src.id, code: 'grade-limited', msg: `지형 추종 종단을 등급 한도로 ${prof.limitedLen.toFixed(0)}m 구간 제한했다 (절토·성토 최대 ${prof.earthwork.toFixed(1)}m)`});
  // 단면(구간 경계 부드러운 전이)
  const sec = new Float64Array(n * SEC.N);
  const half = (k: number): number => { // 경계 k (구간 k-1 | k) 의 전이 반창
    const a = segs[k - 1], b = segs[k];
    return Math.max(0, Math.min(o.sectionBlend / 2, (a.s1 - a.s0) / 2, (b.s1 - b.s0) / 2));
  };
  for (let i = 0; i < n; i++) {
    const k = segIdx[i], g = segs[k], s = d.s[i];
    let base = g.sec, other: number[] | null = null, w = 0;
    if (k > 0 && half(k) > 0 && s < g.s0 + half(k)) { other = segs[k - 1].sec; w = smooth01((s - (g.s0 - half(k))) / (2 * half(k))); base = other; other = g.sec; }
    else if (k < segs.length - 1 && half(k + 1) > 0 && s > g.s1 - half(k + 1)) { other = segs[k + 1].sec; w = smooth01((s - (g.s1 - half(k + 1))) / (2 * half(k + 1))); }
    for (let f = 0; f < SEC.N; f++) {
      let v = base[f];
      if (other) v = f === SEC.lanesN || f === SEC.oneWay ? (w < 0.5 ? base[f] : other[f]) : lerp(base[f], other[f], w);
      sec[i * SEC.N + f] = v;
    }
  }
  // 위험한 급커브 경고: 안쪽 가장자리가 곡률 반경보다 넓다
  let minR = Infinity;
  for (let i = 0; i < n; i++) if (Math.abs(kappa[i]) > 1e-6) minR = Math.min(minR, 1 / Math.abs(kappa[i]) - sideEdges(sec, i * SEC.N, kappa[i] > 0).e3);
  if (minR < 0) warnings.push({owner: src.id, code: 'tight-curve', msg: `곡률 반경이 포장 반폭보다 작은 곳이 있다 (여유 ${minR.toFixed(1)}m). 안쪽 가장자리가 좁게 눌린다`});
  const road: RoadGeo = {id: src.id, cls: src.cls, src, n, length: d.s[n - 1], s: d.s, x: d.x, z: d.z, y: prof.y, tx, tz, grade, kappa, sec, segIdx, segs, maxGrade: cp.maxGrade,
    ctrl: d.ctrl, limitedLen: prof.limitedLen, earthwork: prof.earthwork};
  return {road, rejected, warnings};
}

// ───────── 조회 ─────────
export interface Loc { i: number; f: number }
/** 누적거리 s → (인덱스 i, 비율 f). s 는 [0,length] 로 제한 */
export function locate(r: RoadGeo, s: number): Loc {
  const t = Math.min(Math.max(s, 0), r.length);
  let lo = 0, hi = r.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r.s[m] <= t) lo = m; else hi = m; }
  const span = r.s[hi] - r.s[lo];
  return {i: lo, f: span > 1e-12 ? (t - r.s[lo]) / span : 0};
}
export interface PointAt { s: number; x: number; y: number; z: number; tx: number; tz: number; sec: number[]; seg: number }
export function pointAt(r: RoadGeo, s: number): PointAt {
  const {i, f} = locate(r, s), j = Math.min(i + 1, r.n - 1);
  let tx = lerp(r.tx[i], r.tx[j], f), tz = lerp(r.tz[i], r.tz[j], f);
  const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
  const sec: number[] = [];
  for (let k = 0; k < SEC.N; k++) sec.push(k === SEC.lanesN || k === SEC.oneWay ? r.sec[(f < 0.5 ? i : j) * SEC.N + k] : lerp(r.sec[i * SEC.N + k], r.sec[j * SEC.N + k], f));
  return {s: Math.min(Math.max(s, 0), r.length), x: lerp(r.x[i], r.x[j], f), y: lerp(r.y[i], r.y[j], f), z: lerp(r.z[i], r.z[j], f), tx, tz, sec, seg: r.segIdx[f < 0.5 ? i : j]};
}
/** 표본 i 의 총 반폭(좌/우) */
export const halfWidths = (r: RoadGeo, i: number): [number, number] => [sideEdges(r.sec, i * SEC.N, false).e5, sideEdges(r.sec, i * SEC.N, true).e5];
/** 점 (x,z) 에서 가장 가까운 중심선 위치: s, 거리, 표본 인덱스 (주어진 s 범위 안에서만) */
export function nearestOnRoad(r: RoadGeo, x: number, z: number, s0 = 0, s1 = Infinity): {s: number; dist: number} {
  let best = Infinity, bs = 0;
  const a = locate(r, s0).i, b = Math.min(r.n - 2, locate(r, Math.min(s1, r.length)).i);
  for (let i = a; i <= b; i++) {
    const dx = r.x[i + 1] - r.x[i], dz = r.z[i + 1] - r.z[i], l2 = dx * dx + dz * dz;
    const f = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - r.x[i]) * dx + (z - r.z[i]) * dz) / l2)) : 0;
    const d = Math.hypot(x - (r.x[i] + dx * f), z - (r.z[i] + dz * f));
    if (d < best) { best = d; bs = r.s[i] + f * Math.sqrt(l2); }
  }
  return {s: bs, dist: best};
}

// ───────── 솎아내기·출력 ─────────
export interface ThinTol { pos: number; y: number; w: number; maxStep: number }
export const DEFAULT_THIN: ThinTol = {pos: 0.04, y: 0.025, w: 0.05, maxStep: 12};
/** 조밀 인덱스 [a,b] 를 허용 오차 안에서 솎는다(양 끝 포함). 구간 경계(segIdx 변화)와 차로 수 변화는 반드시 남긴다 */
export function thinIndices(r: RoadGeo, a: number, b: number, tol: ThinTol = DEFAULT_THIN): number[] {
  const must = new Set<number>([a, b]);
  for (let i = a + 1; i <= b; i++) {
    if (r.segIdx[i] !== r.segIdx[i - 1]) { must.add(i); must.add(i - 1); }
    if (r.sec[i * SEC.N + SEC.lanesN] !== r.sec[(i - 1) * SEC.N + SEC.lanesN]) must.add(i);
  }
  for (const c of r.ctrl) if (c > a && c < b) must.add(c);
  const marks = [...must].sort((p, q) => p - q), keep: number[] = [];
  const widths = (i: number) => i * SEC.N;
  for (let m = 0; m < marks.length; m++) {
    keep.push(marks[m]);
    if (m === marks.length - 1) break;
    const stack: [number, number][] = [[marks[m], marks[m + 1]]], found: number[] = [];
    while (stack.length) {
      const [p, q] = stack.pop()!;
      if (q - p < 2) continue;
      const sp = r.s[p], sq = r.s[q], span = sq - sp;
      let worst = 0, wk = -1;
      for (let k = p + 1; k < q; k++) {
        const f = (r.s[k] - sp) / span;
        let dev = Math.max(Math.hypot(r.x[k] - lerp(r.x[p], r.x[q], f), r.z[k] - lerp(r.z[p], r.z[q], f)) / tol.pos, Math.abs(r.y[k] - lerp(r.y[p], r.y[q], f)) / tol.y);
        for (let c = 0; c < SEC.N; c++) if (c !== SEC.lanesN && c !== SEC.oneWay) dev = Math.max(dev, Math.abs(r.sec[widths(k) + c] - lerp(r.sec[widths(p) + c], r.sec[widths(q) + c], f)) / tol.w);
        if (dev > worst) { worst = dev; wk = k; }
      }
      if (span > tol.maxStep && worst <= 1) { wk = Math.round((p + q) / 2); worst = 2; }
      if (worst > 1 && wk > p && wk < q) { found.push(wk); stack.push([p, wk], [wk, q]); }
    }
    found.sort((u, v) => u - v);
    for (const k of found) keep.push(k);
  }
  return keep;
}
export function toCompiledRoad(r: RoadGeo, tol: ThinTol = DEFAULT_THIN): CompiledRoad {
  const idx = thinIndices(r, 0, r.n - 1, tol), samples: RoadSample[] = [];
  for (const i of idx) {
    const [hl, hr] = halfWidths(r, i);
    samples.push({s: rnd(r.s[i]), x: rnd(r.x[i]), y: rnd(r.y[i]), z: rnd(r.z[i]), yaw: rnd(Math.atan2(r.tx[i], r.tz[i]), 3), hwL: rnd(hl), hwR: rnd(hr), grade: rnd(r.grade[i], 4)});
  }
  const pos = new Map<number, number>();
  idx.forEach((v, k) => pos.set(v, k));
  const nearest = (di: number): number => { let lo = 0, hi = idx.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (idx[m] < di) lo = m + 1; else hi = m; } return lo; };
  return {id: r.id, cls: r.cls, curve: r.src.curve, length: rnd(r.length), samples,
    segments: r.segs.map(g => ({id: g.id, i0: nearest(g.i0), i1: nearest(g.i1), layer: g.layer, kind: g.kind}))};
}
export const yawOf = (tx: number, tz: number): number => wrapPi(Math.atan2(tx, tz));
export const CURB_H = SCALE.curbH;
