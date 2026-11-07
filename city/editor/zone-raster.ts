// 구역 브러시용 격자 마스크 연산(순수, DOM 없음): 다각형 래스터화, 브러시 찍기, 핀치 보정, 구멍 메우기, 연결 성분, 외곽선 추적, 단순화.
// 좌표 격자는 전역 정렬(셀 크기의 배수)이라 외곽선 꼭짓점이 깔끔한 값이 된다.
import type {Pt} from '../city-schema.js';
import {LIMITS} from '../city-schema.js';

export interface Grid { x0: number; z0: number; cell: number; w: number; h: number }
export interface Mask { g: Grid; a: Uint8Array }
export const CELL_MIN = 2;
const PAD = 3;

export function bboxOf(pts: ArrayLike<number>[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  return [x0, z0, x1, z1];
}
/** bbox 를 덮는 격자. 한 변이 600셀을 넘지 않도록 셀을 키운다 */
export function makeGrid(bb: [number, number, number, number]): Grid {
  const span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  const cell = Math.max(CELL_MIN, Math.ceil(span / 600 / 0.5) * 0.5);
  const x0 = Math.floor(bb[0] / cell) * cell - PAD * cell, z0 = Math.floor(bb[1] / cell) * cell - PAD * cell;
  return {x0, z0, cell, w: Math.ceil((bb[2] - x0) / cell) + PAD + 1, h: Math.ceil((bb[3] - z0) / cell) + PAD + 1};
}
export const newMask = (g: Grid): Mask => ({g, a: new Uint8Array(g.w * g.h)});
export const cloneMask = (m: Mask): Mask => ({g: m.g, a: m.a.slice()});
export const count = (m: Mask) => { let n = 0; for (let i = 0; i < m.a.length; i++) n += m.a[i]; return n; };
export const sameMask = (p: Mask, q: Mask) => { for (let i = 0; i < p.a.length; i++) if (p.a[i] !== q.a[i]) return false; return true; };
export function intersects(p: Mask, q: Mask): boolean { for (let i = 0; i < p.a.length; i++) if (p.a[i] & q.a[i]) return true; return false; }

/** 짝홀 규칙 스캔라인 채우기 (셀 중심 기준) */
export function rasterPoly(poly: Pt[], g: Grid): Mask {
  const m = newMask(g), xs: number[] = [];
  for (let j = 0; j < g.h; j++) {
    const zc = g.z0 + (j + 0.5) * g.cell;
    xs.length = 0;
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const [xi, zi] = poly[i], [xk, zk] = poly[k];
      if (zi > zc !== zk > zc) xs.push(xi + ((zc - zi) / (zk - zi)) * (xk - xi));
    }
    xs.sort((p, q) => p - q);
    for (let t = 0; t + 1 < xs.length; t += 2) {
      const i0 = Math.max(0, Math.ceil((xs[t] - g.x0) / g.cell - 0.5)), i1 = Math.min(g.w - 1, Math.floor((xs[t + 1] - g.x0) / g.cell - 0.5));
      for (let i = i0; i <= i1; i++) m.a[j * g.w + i] = 1;
    }
  }
  return m;
}
/** 스트로크(점 목록, 반경 r)를 캡슐 합집합으로 찍는다. 격자 밖은 무시 */
export function stamp(m: Mask, pts: Pt[], r: number, value = 1) {
  const g = m.g, re = Math.max(r, g.cell * 0.75), r2 = re * re;
  const one = (ax: number, az: number, bx: number, bz: number) => {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - re - g.x0) / g.cell)), i1 = Math.min(g.w - 1, Math.ceil((Math.max(ax, bx) + re - g.x0) / g.cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - re - g.z0) / g.cell)), j1 = Math.min(g.h - 1, Math.ceil((Math.max(az, bz) + re - g.z0) / g.cell));
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = g.x0 + (i + 0.5) * g.cell, cz = g.z0 + (j + 0.5) * g.cell;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / l2)) : 0;
      const ex = cx - (ax + dx * t), ez = cz - (az + dz * t);
      if (ex * ex + ez * ez <= r2) m.a[j * g.w + i] = value;
    }
  };
  if (pts.length === 1) one(pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) one(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
}
/** a 에서 b 영역을 뺀다 / a 에 b 를 더한다 */
export function subtract(a: Mask, b: Mask) { for (let i = 0; i < a.a.length; i++) if (b.a[i]) a.a[i] = 0; }
export function union(a: Mask, b: Mask) { for (let i = 0; i < a.a.length; i++) if (b.a[i]) a.a[i] = 1; }

/** 대각선으로만 맞닿은 셀 쌍(꼭짓점 한 점에서 닿는 모양)을 채운다 → 외곽선이 한 점에서 스스로 닿지 않게 */
export function fixPinch(m: Mask) {
  const {w, h} = m.g, a = m.a;
  for (let pass = 0; pass < 6; pass++) {
    let ch = false;
    for (let j = 0; j + 1 < h; j++) for (let i = 0; i + 1 < w; i++) {
      const p = j * w + i, A = a[p], B = a[p + 1], C = a[p + w], D = a[p + w + 1];
      if (A && D && !B && !C) { a[p + 1] = 1; ch = true; } else if (B && C && !A && !D) { a[p] = 1; ch = true; }
    }
    if (!ch) break;
  }
}
/** 바깥과 이어지지 않은 빈 셀(구멍)을 메운다. 메운 셀 수 */
export function fillHoles(m: Mask): number {
  const {w, h} = m.g, a = m.a, out = new Uint8Array(w * h), st: number[] = [];
  const push = (i: number) => { if (!a[i] && !out[i]) { out[i] = 1; st.push(i); } };
  for (let i = 0; i < w; i++) { push(i); push((h - 1) * w + i); }
  for (let j = 0; j < h; j++) { push(j * w); push(j * w + w - 1); }
  while (st.length) {
    const p = st.pop()!, i = p % w, j = (p - i) / w;
    if (i > 0) push(p - 1); if (i < w - 1) push(p + 1); if (j > 0) push(p - w); if (j < h - 1) push(p + w);
  }
  let n = 0;
  for (let p = 0; p < a.length; p++) if (!a[p] && !out[p]) { a[p] = 1; n++; }
  return n;
}
/** 4-연결 성분들 (셀 수 큰 순) */
export function components(m: Mask): Mask[] {
  const {w, h} = m.g, a = m.a, seen = new Uint8Array(w * h), outs: Mask[] = [];
  for (let s = 0; s < a.length; s++) {
    if (!a[s] || seen[s]) continue;
    const comp = newMask(m.g), st = [s]; seen[s] = 1;
    while (st.length) {
      const p = st.pop()!, i = p % w, j = (p - i) / w;
      comp.a[p] = 1;
      const nb = [i > 0 ? p - 1 : -1, i < w - 1 ? p + 1 : -1, j > 0 ? p - w : -1, j < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && a[q] && !seen[q]) { seen[q] = 1; st.push(q); }
    }
    outs.push(comp);
  }
  return outs.sort((p, q) => count(q) - count(p));
}
/** 구멍 없는 한 성분의 바깥 외곽선(꼭짓점, 동일 방향 공선점 제거) */
export function traceOuter(m: Mask): Pt[] {
  const {w, h, x0, z0, cell} = m.g, a = m.a, W = w + 1;
  const next = new Map<number, number>();
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && a[j * w + i] === 1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!a[j * w + i]) continue;
    if (!inside(i, j - 1)) next.set(j * W + i, j * W + i + 1);
    if (!inside(i + 1, j)) next.set(j * W + i + 1, (j + 1) * W + i + 1);
    if (!inside(i, j + 1)) next.set((j + 1) * W + i + 1, (j + 1) * W + i);
    if (!inside(i - 1, j)) next.set((j + 1) * W + i, j * W + i);
  }
  let best: number[] = [];
  const used = new Set<number>();
  for (const s of next.keys()) {
    if (used.has(s)) continue;
    const loop: number[] = []; let v = s;
    while (!used.has(v)) { used.add(v); loop.push(v); const n = next.get(v); if (n === undefined) break; v = n; }
    if (loop.length > best.length) best = loop;
  }
  const raw = best.map(v => [v % W, Math.floor(v / W)] as [number, number]);
  const out: Pt[] = [];
  for (let k = 0; k < raw.length; k++) {
    const p = raw[(k + raw.length - 1) % raw.length], q = raw[k], n = raw[(k + 1) % raw.length];
    if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push([x0 + q[0] * cell, z0 + q[1] * cell]);
  }
  return out;
}
// ───────── 단순화 ─────────
function rdp(p: Pt[], i0: number, i1: number, tol: number, keep: boolean[]) {
  let md = 0, mi = -1;
  const [ax, az] = p[i0], [bx, bz] = p[i1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
  for (let i = i0 + 1; i < i1; i++) {
    const d = l > 0 ? Math.abs((p[i][0] - ax) * dz - (p[i][1] - az) * dx) / l : Math.hypot(p[i][0] - ax, p[i][1] - az);
    if (d > md) { md = d; mi = i; }
  }
  if (mi >= 0 && md > tol) { keep[mi] = true; rdp(p, i0, mi, tol, keep); rdp(p, mi, i1, tol, keep); }
}
export function simplifyRing(ring: Pt[], tol: number): Pt[] {
  const n = ring.length;
  if (n < 4) return ring.slice();
  let far = 1, fd = 0;
  for (let i = 1; i < n; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  const keep = new Array<boolean>(n).fill(false); keep[0] = keep[far] = true;
  const a = ring.slice(0, far + 1), b = [...ring.slice(far), ring[0]], ka = new Array<boolean>(a.length).fill(false), kb = new Array<boolean>(b.length).fill(false);
  ka[0] = ka[a.length - 1] = kb[0] = kb[b.length - 1] = true;
  rdp(a, 0, a.length - 1, tol, ka); rdp(b, 0, b.length - 1, tol, kb);
  return [...a.filter((_, i) => ka[i]), ...b.filter((_, i) => kb[i]).slice(1, -1)];
}
const cr = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
function crosses(a: Pt, b: Pt, c: Pt, d: Pt) {
  const d1 = cr(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]), d2 = cr(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  const d3 = cr(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]), d4 = cr(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
/** 스키마 검증(checkPoly)과 같은 기준: 이웃 점 동일 없음, 변 교차 없음, 면적>0 */
export function polyValid(p: Pt[]): boolean {
  const n = p.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) if (Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]) < 0.05) return false;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (crosses(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return false;
  }
  let s = 0;
  for (let i = 0; i < n; i++) { const q = p[(i + 1) % n]; s += p[i][0] * q[1] - q[0] * p[i][1]; }
  return Math.abs(s / 2) > 1e-6;
}
/** 외곽선 → 스키마를 통과하는 다각형(≤ zonePts 점). 실패하면 null */
export function ringToPoly(ring: Pt[], cell: number): Pt[] | null {
  const rd = (p: Pt): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
  for (let tol = cell * 0.6; tol <= cell * 12; tol *= 1.4) {
    const s = simplifyRing(ring, tol).map(rd);
    if (s.length <= LIMITS.zonePts && polyValid(s)) return s;
  }
  const raw = ring.map(rd);
  return raw.length <= LIMITS.zonePts && polyValid(raw) ? raw : null;
}
