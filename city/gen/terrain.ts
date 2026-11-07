// 지형 래스터: 기본 격자 해독 → terrain.edits(pad/brush/corridor) 적용 → 최종 높이. 순수·결정적(같은 입력 → 같은 비트).
// 적용 순서(문서 CITYGEN.md): ① 1차 편집 = pad·brush 를 배열 순서대로 ② 도로 종단 확정 ③ corridor(도로 회랑) ④ 교차로 포장 평탄화.
import {DEFAULTS, RANGES} from '../city-schema.js';
import type {CitySource, TerrainEdit} from '../city-schema.js';
import type {TerrainCompiled} from '../city-compiled.js';
import {checksumCm, decodeHeights, encodeHeights} from '../city-terrain-codec.js';
import {encodeBytesRle} from './bytes.js';
import {clamp, distPointSeg, hyp, smooth01} from './geom.js';
import type {P2} from './geom.js';

export interface Terrain {
  cell: number; x0: number; z0: number; cols: number; rows: number;
  /** 해발(m), 행 우선 j*cols+i */
  h: Float64Array;
  /** 도로 포장·회랑 평탄 구역 표시(0/1). 마스크 출력용 */
  road: Uint8Array;
}
/** 호출자가 넘기는 기본 높이(ref 파일을 읽어 디코딩한 것). cm 정수 */
export interface BaseHeights { cols: number; rows: number; cm: ArrayLike<number> }

export function makeTerrain(g: {cell: number; x0: number; z0: number; cols: number; rows: number}, cm: ArrayLike<number>): Terrain {
  const n = g.cols * g.rows;
  if (cm.length !== n) throw new Error(`citygen: 높이 배열 길이 ${cm.length} 가 cols*rows ${n} 와 다르다`);
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = cm[i] / 100;
  return {cell: g.cell, x0: g.x0, z0: g.z0, cols: g.cols, rows: g.rows, h, road: new Uint8Array(n)};
}
export function cloneTerrain(t: Terrain): Terrain {
  return {...t, h: Float64Array.from(t.h), road: Uint8Array.from(t.road)};
}
/** 원본의 격자 정의 + 인라인 data 또는 base 로 지형을 만든다. 해시가 있으면 체크섬을 검증한다 */
export function terrainFromSource(src: CitySource, base?: BaseHeights): Terrain {
  const g = src.terrain.grid, n = g.cols * g.rows;
  let cm: ArrayLike<number>;
  if (g.data) cm = decodeHeights(g.data, n);
  else if (base) {
    if (base.cols !== g.cols || base.rows !== g.rows) throw new Error(`citygen: 기본 높이 격자 ${base.cols}x${base.rows} 가 원본 격자 ${g.cols}x${g.rows} 와 다르다`);
    cm = base.cm;
  } else throw new Error('citygen: terrain.grid.data 가 없고 baseHeights 도 주어지지 않았다 (ref 파일을 호출자가 읽어 넘겨야 한다)');
  if (g.hash && checksumCm(cm) !== g.hash) throw new Error('citygen: 높이 격자 해시가 일치하지 않는다');
  return makeTerrain(g, cm);
}

// ───────── 표본 추출 ─────────
export function sampleBilinear(t: Terrain, x: number, z: number): number {
  const u = clamp((x - t.x0) / t.cell, 0, t.cols - 1), v = clamp((z - t.z0) / t.cell, 0, t.rows - 1);
  const i = Math.min(Math.floor(u), t.cols - 2), j = Math.min(Math.floor(v), t.rows - 2), fu = u - i, fv = v - j, c = t.cols;
  const a = t.h[j * c + i], b = t.h[j * c + i + 1], d = t.h[(j + 1) * c + i], e = t.h[(j + 1) * c + i + 1];
  return a + (b - a) * fu + (d - a) * fv + (a - b - d + e) * fu * fv;
}
const crW = (f: number): number[] => [(-f * f * f + 2 * f * f - f) / 2, (3 * f * f * f - 5 * f * f + 2) / 2, (-3 * f * f * f + 4 * f * f + f) / 2, (f * f * f - f * f) / 2];
/** 쌍삼차(Catmull-Rom 4x4). 경계는 가장자리 값을 늘려 쓴다 */
export function sampleBicubic(t: Terrain, x: number, z: number): number {
  const u = clamp((x - t.x0) / t.cell, 0, t.cols - 1), v = clamp((z - t.z0) / t.cell, 0, t.rows - 1);
  const i = Math.floor(u), j = Math.floor(v), wu = crW(u - i), wv = crW(v - j);
  let r = 0;
  for (let b = 0; b < 4; b++) {
    const jj = clamp(j - 1 + b, 0, t.rows - 1);
    let row = 0;
    for (let a = 0; a < 4; a++) row += wu[a] * t.h[jj * t.cols + clamp(i - 1 + a, 0, t.cols - 1)];
    r += wv[b] * row;
  }
  return r;
}
/** 한 점의 경사(비율 = 기울기 크기). 이중선형 면의 중앙 차분(±cell/2) */
export function slopeAt(t: Terrain, x: number, z: number): number {
  const e = t.cell / 2;
  const gx = (sampleBilinear(t, x + e, z) - sampleBilinear(t, x - e, z)) / (2 * e), gz = (sampleBilinear(t, x, z + e) - sampleBilinear(t, x, z - e)) / (2 * e);
  return hyp(gx, gz);
}
/** 칸마다 경사(비율) */
export function slopeMap(t: Terrain): Float32Array {
  const out = new Float32Array(t.cols * t.rows), c = t.cols;
  for (let j = 0; j < t.rows; j++) for (let i = 0; i < c; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(c - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(t.rows - 1, j + 1);
    const gx = (t.h[j * c + i1] - t.h[j * c + i0]) / ((i1 - i0) * t.cell), gz = (t.h[j1 * c + i] - t.h[j0 * c + i]) / ((j1 - j0) * t.cell);
    out[j * c + i] = hyp(gx, gz);
  }
  return out;
}

// ───────── 부지 보고 (필지 배치용) ─────────
export interface SiteReport {
  /** 발자국 표본의 국지 경사 최대 / 평균 */
  maxSlope: number; meanSlope: number;
  /** 최소제곱 평면의 경사(비율) — 건물 대지 판정(buildingMaxSlope)에 쓰는 값 */
  planeSlope: number;
  minH: number; maxH: number; relief: number; centerH: number;
  okSlope: boolean; okAlt: boolean; ok: boolean;
}
/** 회전 발자국(중심 cx,cz, 폭 w(x), 깊이 d(z), 회전 rotDeg: 스키마 BuildingSource.rot 규칙)의 경사·고도 보고 */
export function siteReport(t: Terrain, cx: number, cz: number, w: number, d: number, rotDeg = 0, maxSlope: number = DEFAULTS.buildingMaxSlope, maxAlt: number = DEFAULTS.buildingMaxAlt): SiteReport {
  const th = (rotDeg * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
  const nx = Math.max(3, Math.ceil(w / (t.cell / 2)) + 1), nz = Math.max(3, Math.ceil(d / (t.cell / 2)) + 1);
  let n = 0, mn = Infinity, mx = -Infinity, ms = 0, sumS = 0, sx = 0, sz = 0, sh = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
  for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
    const lx = -w / 2 + (w * a) / (nx - 1), lz = -d / 2 + (d * b) / (nz - 1);
    const x = cx + lx * co + lz * si, z = cz - lx * si + lz * co, hh = sampleBilinear(t, x, z), s = slopeAt(t, x, z);
    n++; mn = Math.min(mn, hh); mx = Math.max(mx, hh); ms = Math.max(ms, s); sumS += s;
    sx += lx; sz += lz; sh += hh; sxx += lx * lx; szz += lz * lz; sxz += lx * lz; sxh += lx * hh; szh += lz * hh;
  }
  // 정규방정식 h = a + gx*lx + gz*lz
  const mxl = sx / n, mzl = sz / n, mh = sh / n;
  const cxx = sxx / n - mxl * mxl, czz = szz / n - mzl * mzl, cxz = sxz / n - mxl * mzl, cxh = sxh / n - mxl * mh, czh = szh / n - mzl * mh;
  const det = cxx * czz - cxz * cxz;
  const gx = Math.abs(det) > 1e-12 ? (cxh * czz - czh * cxz) / det : 0, gz = Math.abs(det) > 1e-12 ? (czh * cxx - cxh * cxz) / det : 0;
  const plane = hyp(gx, gz);
  const okSlope = plane <= maxSlope && ms <= maxSlope * 2, okAlt = mx <= maxAlt;
  return {maxSlope: ms, meanSlope: sumS / n, planeSlope: plane, minH: mn, maxH: mx, relief: mx - mn, centerH: sampleBilinear(t, cx, cz), okSlope, okAlt, ok: okSlope && okAlt};
}

// ───────── 편집 ─────────
function forCells(t: Terrain, x0: number, z0: number, x1: number, z1: number, f: (idx: number, x: number, z: number) => void): void {
  const i0 = Math.max(0, Math.floor((x0 - t.x0) / t.cell)), i1 = Math.min(t.cols - 1, Math.ceil((x1 - t.x0) / t.cell));
  const j0 = Math.max(0, Math.floor((z0 - t.z0) / t.cell)), j1 = Math.min(t.rows - 1, Math.ceil((z1 - t.z0) / t.cell));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * t.cols + i, t.x0 + i * t.cell, t.z0 + j * t.cell);
}
// ───────── 시드 기반 윤곽 비틀림(warp) ─────────
export type Warp = {amp: number; lambda: number; seed: number};
const lat = (i: number, j: number, seed: number): number => {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
};
/** 값 잡음(쌍선형·smoothstep) -1..1 */
function vnoise(x: number, z: number, seed: number): number {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = lat(i, j, seed), b = lat(i + 1, j, seed), c = lat(i, j + 1, seed), d = lat(i + 1, j + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** fbm 3 옥타브(파장 λ, λ/2, λ/4; 진폭 1, .5, .25) × amp → 대략 [-amp, +amp]. 위치만의 순수 함수 */
export function warpAt(w: Warp, x: number, z: number): number {
  let s = 0, a = 1, f = 1 / w.lambda, n = 0;
  for (let o = 0; o < 3; o++) { s += a * vnoise(x * f + o * 17.3, z * f - o * 9.1, w.seed + o * 101); n += a; a *= 0.5; f *= 2; }
  return (w.amp * s) / n * 1.6;
}
/** 평탄화 패드: 반경 r 안은 y(없으면 적용 시점의 중심 높이)로 평지. 바깥은 y 로부터 경사 k=10/falloff(상승/수평)의 포락선으로
 * 높이를 잘라 이어 붙인다(깎기·쌓기 비탈). 포락선 clamp 이라 같은 편집을 다시 적용해도 결과가 변하지 않는다(멱등) */
export function applyPad(t: Terrain, e: Extract<TerrainEdit, {kind: 'pad'}>): void {
  const y = e.y !== undefined ? e.y : sampleBilinear(t, e.x, e.z), k = clamp(10 / Math.max(e.falloff, 2), 0.2, 5), R = e.r * (1 + (e.warp ? 0.18 : 0)) + Math.min(300, 150 / k);
  forCells(t, e.x - R, e.z - R, e.x + R, e.z + R, (idx, x, z) => {
    const d = hyp(x - e.x, z - e.z), wv = e.warp ? warpAt(e.warp, x, z) : 0;
    // 평지 반경은 r 이상(최대 +30%)으로만 위치별로 늘어 둥근 윤곽이 사라지고(r 안은 언제나 평평), 바깥 비탈의 경사도 k·(1±warp)로 변해 폭이 불규칙하다. 위치만의 함수 + 포락선 clamp 이라 멱등
    const rf = e.r * (1 + clamp(0.8 * wv, 0, 0.18));
    if (d <= rf) { t.h[idx] = y; t.road[idx] |= 2; }
    else if (d < R) { const kk = e.warp ? k * clamp(1 + 0.5 * wv, 0.9, 1.2) : k, env = (d - rf) * kk; t.h[idx] = clamp(t.h[idx], y - env, y + env); }
  });
}
/** 붓: 획(pts) 둘레 r 에서 부드러운 가중치로 올림/내림/평탄/평활 */
export function applyBrush(t: Terrain, e: Extract<TerrainEdit, {kind: 'brush'}>): void {
  const pts = e.pts, snap = e.mode === 'smooth' ? Float64Array.from(t.h) : t.h;
  let target = 0;
  if (e.mode === 'flatten') { for (const p of pts) target += sampleBilinear(t, p[0], p[1]); target /= pts.length; }
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  const ext = e.r * (1 + (e.warp ? Math.min(0.9, e.warp.amp * 1.6) : 0));
  forCells(t, Math.min(...xs) - ext, Math.min(...zs) - ext, Math.max(...xs) + ext, Math.max(...zs) + ext, (idx, x, z) => {
    let d = Infinity;
    if (pts.length === 1) d = hyp(x - pts[0][0], z - pts[0][1]);
    else for (let k = 1; k < pts.length; k++) d = Math.min(d, distPointSeg(x, z, pts[k - 1], pts[k]));
    if (e.warp) d /= Math.max(0.35, 1 + warpAt(e.warp, x, z)); // 위치별로 유효 반경이 늘고 줄어 윤곽이 불규칙
    if (d >= e.r) return;
    const w = smooth01(1 - d / e.r), st = clamp(e.strength, 0, 1);
    if (e.mode === 'raise') t.h[idx] += e.strength * w;
    else if (e.mode === 'lower') t.h[idx] -= e.strength * w;
    else if (e.mode === 'flatten') t.h[idx] += (target - t.h[idx]) * w * st;
    else {
      const i = idx % t.cols, j = (idx - i) / t.cols;
      let sum = 0, cnt = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < t.cols && jj < t.rows) { sum += snap[jj * t.cols + ii]; cnt++; }
      }
      t.h[idx] += (sum / cnt - t.h[idx]) * w * st;
    }
  });
}
/** 1차 편집(pad, brush)을 배열 순서대로 적용. corridor 는 도로 종단이 확정된 뒤 별도 단계 */
export function applyPreEdits(t: Terrain, edits: TerrainEdit[]): void {
  for (const e of edits) {
    if (e.kind === 'pad') applyPad(t, e);
    else if (e.kind === 'brush') applyBrush(t, e);
  }
}

/** 회랑 꼭짓점: 도로 중심 표본의 최종 종단과 단면 */
export interface CorridorVertex {
  x: number; z: number; y: number;
  /** 포장(차도+연석 안쪽까지) 반폭 — 이 안은 노면보다 PAVE_DROP 아래 */
  wcL: number; wcR: number;
  /** 평탄 반폭(보도+식재대까지) — 이 안은 노면 +VERGE_RISE */
  hwL: number; hwR: number;
}
export const PAVE_DROP = 0.12;
export const VERGE_RISE = 0.05;
/** 한 도로 구간(연속 꼭짓점)을 따라 절토/성토 회랑. cut/fill = 수평:수직 비율(≥0.5), shoulder = 평탄 어깨 폭(m) */
export function carveCorridor(t: Terrain, v: CorridorVertex[], cut: number, fill: number, shoulder: number): void {
  const cutR = Math.max(cut, 0.5), fillR = Math.max(fill, 0.5), reach = Math.min(80, 14 * Math.max(cutR, fillR));
  // 칸마다 가장 가까운 구간이 결정한다(구간 끝 너머의 먼 구간이 덮어쓰지 않게). 원래 높이는 처음 만날 때 저장
  const best = new Map<number, {d: number; h0: number}>();
  for (let k = 1; k < v.length; k++) {
    const a = v[k - 1], b = v[k], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz, l = Math.sqrt(l2);
    if (l < 1e-9) continue;
    const wmax = Math.max(a.hwL, a.hwR, b.hwL, b.hwR) + shoulder + reach;
    const nx = -dz / l, nz = dx / l; // nR
    forCells(t, Math.min(a.x, b.x) - wmax, Math.min(a.z, b.z) - wmax, Math.max(a.x, b.x) + wmax, Math.max(a.z, b.z) + wmax, (idx, x, z) => {
      const f = clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1), px = a.x + dx * f, pz = a.z + dz * f;
      const dd = hyp(x - px, z - pz), right = (x - px) * nx + (z - pz) * nz >= 0;
      let e = best.get(idx);
      if (!e) { e = {d: Infinity, h0: t.h[idx]}; best.set(idx, e); }
      if (dd >= e.d) return;
      e.d = dd;
      const y = a.y + (b.y - a.y) * f;
      const wc = right ? a.wcR + (b.wcR - a.wcR) * f : a.wcL + (b.wcL - a.wcL) * f;
      const hw = (right ? a.hwR + (b.hwR - a.hwR) * f : a.hwL + (b.hwL - a.hwL) * f) + shoulder;
      if (dd <= wc) { t.h[idx] = y - PAVE_DROP; t.road[idx] |= 1; }
      else if (dd <= hw) { t.h[idx] = y + VERGE_RISE; t.road[idx] |= 1; }
      else {
        const ex = dd - hw, base = y + VERGE_RISE;
        t.h[idx] = e.h0 > base ? Math.min(e.h0, base + ex / cutR) : Math.max(e.h0, base - ex / fillR);
      }
    });
  }
}
/** 삼각형 목록(xyz 9개씩)의 칸 중심을 보간 높이 - drop 으로 맞춘다 (교차로 포장·보도 코너용) */
export function rasterTriangles(t: Terrain, tris: ArrayLike<number>, drop: number): void {
  for (let q = 0; q + 8 < tris.length; q += 9) {
    const ax = tris[q], ay = tris[q + 1], az = tris[q + 2], bx = tris[q + 3], by = tris[q + 4], bz = tris[q + 5], cx = tris[q + 6], cy = tris[q + 7], cz = tris[q + 8];
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-9) continue;
    forCells(t, Math.min(ax, bx, cx), Math.min(az, bz, cz), Math.max(ax, bx, cx), Math.max(az, bz, cz), (idx, x, z) => {
      const w1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den, w2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den, w3 = 1 - w1 - w2;
      if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) return;
      t.h[idx] = w1 * ay + w2 * by + w3 * cy - drop; t.road[idx] |= 1;
    });
  }
}

// ───────── 출력 ─────────
/** surfaceMask 비트: 0~1 경사 등급(0:<3% 1:<12% 2:<30% 3:≥30%) · 2 고도>건축 상한 · 3 도로/패드 평탄 구역 */
export function terrainMask(t: Terrain): Uint8Array {
  const sl = slopeMap(t), m = new Uint8Array(t.h.length);
  for (let i = 0; i < m.length; i++) {
    const s = sl[i];
    m[i] = (s < 0.03 ? 0 : s < DEFAULTS.buildingMaxSlope ? 1 : s < 0.3 ? 2 : 3) | (t.h[i] > DEFAULTS.buildingMaxAlt ? 4 : 0) | (t.road[i] ? 8 : 0);
  }
  return m;
}
export function encodeTerrainCompiled(t: Terrain, withMask = true): TerrainCompiled {
  const cm = new Int32Array(t.h.length);
  for (let i = 0; i < cm.length; i++) cm[i] = Math.round(t.h[i] * 100);
  const out: TerrainCompiled = {cell: t.cell, x0: t.x0, z0: t.z0, cols: t.cols, rows: t.rows, heightData: encodeHeights(cm)};
  if (withMask) out.surfaceMask = encodeBytesRle(terrainMask(t));
  return out;
}
/** 경계 안내: RANGES.cell 과 격자 간격이 다르면 경고용 */
export const gridCellOk = (t: Terrain): boolean => t.cell === RANGES.cell;
/** 점이 격자 범위 안인가 */
export const insideGrid = (t: Terrain, x: number, z: number): boolean => x >= t.x0 && z >= t.z0 && x <= t.x0 + (t.cols - 1) * t.cell && z <= t.z0 + (t.rows - 1) * t.cell;
export type { P2 };
