// 2D/3D 기하 도우미 (순수). 좌표 x(동+)·z(남+). 모든 곡선 샘플링은 결정적이며 DOM/THREE 가 없다.
// 규칙: 접선 t, 오른쪽 법선 nR = (-tz, tx), 왼쪽 nL = (tz, -tx). 곡률 부호 + 이면 오른쪽(nR)으로 도는 중.

export type P2 = [number, number];
export const EPS = 1e-9;

export const wrapPi = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth01 = (t: number): number => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
export const hyp = (x: number, z: number): number => Math.sqrt(x * x + z * z);

// ───────── Catmull-Rom (centripetal) ─────────
const KN = (a: P2, b: P2): number => Math.sqrt(Math.max(hyp(b[0] - a[0], b[1] - a[1]), 1e-6));
/** p1→p2 구간의 centripetal Catmull-Rom 점 (u 0~1). Barry-Goldman 피라미드 */
export function crPoint(p0: P2, p1: P2, p2: P2, p3: P2, u: number): P2 {
  const t0 = 0, t1 = t0 + KN(p0, p1), t2 = t1 + KN(p1, p2), t3 = t2 + KN(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const mix = (a: P2, b: P2, ta: number, tb: number): P2 => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2), b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}
function distToChord(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  if (l2 < EPS) return hyp(p[0] - a[0], p[1] - a[1]);
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2, 0, 1);
  return hyp(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}
/** 한 구간을 오차 maxErr(m) 이하로 적응 분할한 꺾은선(시작·끝 포함). budget.n 이 0 이하가 되면 더 쪼개지 않는다 */
export function flattenCatmullSpan(p0: P2, p1: P2, p2: P2, p3: P2, maxErr: number, budget: {n: number}): P2[] {
  const out: P2[] = [p1];
  const rec = (ua: number, ub: number, pa: P2, pb: P2, depth: number): void => {
    const um = (ua + ub) / 2, pm = crPoint(p0, p1, p2, p3, um);
    const q1 = crPoint(p0, p1, p2, p3, (ua + um) / 2), q3 = crPoint(p0, p1, p2, p3, (um + ub) / 2);
    const err = Math.max(distToChord(pm, pa, pb), distToChord(q1, pa, pb), distToChord(q3, pa, pb));
    if ((err > maxErr || depth < 2) && depth < 14 && budget.n > 0) {
      budget.n--;
      rec(ua, um, pa, pm, depth + 1);
      rec(um, ub, pm, pb, depth + 1);
    } else out.push(pb);
  };
  rec(0, 1, p1, p2, 0);
  return out;
}

// ───────── 조밀 중심선 ─────────
export interface Dense {
  n: number;
  x: Float64Array; z: Float64Array;
  /** 시작점부터의 누적거리 */
  s: Float64Array;
  /** 제어점 i 가 놓인 표본 인덱스 */
  ctrl: number[];
  /** 표본 수 상한에 걸려 간격을 늘렸는가 */
  capped: boolean;
}
/** 제어점 → 균일 간격(step) 조밀 표본. 제어점은 항상 표본이 된다. curve='line' 은 꺾은선, 'catmull' 은 곡선 */
export function sampleControlPath(pts: P2[], curve: 'line' | 'catmull', maxErr: number, step: number, cap: number): Dense {
  const spans: P2[][] = [];
  const nSeg = pts.length - 1;
  const budget = {n: cap * 4};
  for (let i = 0; i < nSeg; i++) {
    if (curve === 'line' || pts.length === 2) { spans.push([pts[i], pts[i + 1]]); continue; }
    const p0 = i > 0 ? pts[i - 1] : ([2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]] as P2);
    const p3 = i + 2 < pts.length ? pts[i + 2] : ([2 * pts[i + 1][0] - pts[i][0], 2 * pts[i + 1][1] - pts[i][1]] as P2);
    spans.push(flattenCatmullSpan(p0, pts[i], pts[i + 1], p3, maxErr, budget));
  }
  const lens = spans.map(sp => { let l = 0; for (let k = 1; k < sp.length; k++) l += hyp(sp[k][0] - sp[k - 1][0], sp[k][1] - sp[k - 1][1]); return l; });
  const total = lens.reduce((a, b) => a + b, 0);
  let st = step, capped = false;
  if (total / st + nSeg + 1 > cap) { st = total / Math.max(1, cap - nSeg - 2); capped = true; }
  const xs: number[] = [], zs: number[] = [], ctrl: number[] = [];
  for (let i = 0; i < nSeg; i++) {
    const sp = spans[i], L = lens[i], m = Math.max(1, Math.ceil(L / st - 1e-9));
    // 꺾은선 sp 를 호장 기준 m 등분
    const cum = [0];
    for (let k = 1; k < sp.length; k++) cum.push(cum[k - 1] + hyp(sp[k][0] - sp[k - 1][0], sp[k][1] - sp[k - 1][1]));
    let k = 1;
    if (i === 0) { ctrl.push(0); xs.push(sp[0][0]); zs.push(sp[0][1]); }
    for (let j = 1; j <= m; j++) {
      if (j === m) { xs.push(sp[sp.length - 1][0]); zs.push(sp[sp.length - 1][1]); continue; }
      const target = (L * j) / m;
      while (k < sp.length - 1 && cum[k] < target) k++;
      const seg = cum[k] - cum[k - 1], w = seg > EPS ? (target - cum[k - 1]) / seg : 0;
      xs.push(lerp(sp[k - 1][0], sp[k][0], w)); zs.push(lerp(sp[k - 1][1], sp[k][1], w));
    }
    ctrl.push(xs.length - 1);
  }
  const n = xs.length, x = Float64Array.from(xs), z = Float64Array.from(zs), s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + hyp(x[i] - x[i - 1], z[i] - z[i - 1]);
  return {n, x, z, s, ctrl, capped};
}

/** 단위 접선 (중앙 차분, 끝은 한쪽) */
export function tangents(x: Float64Array, z: Float64Array): {tx: Float64Array; tz: Float64Array} {
  const n = x.length, tx = new Float64Array(n), tz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = x[b] - x[a], dz = z[b] - z[a], l = hyp(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l;
  }
  return {tx, tz};
}
/** 부호 있는 곡률(1/m, + = 오른쪽으로 도는 중). 창 길이 win(m) 위의 방향 변화 / 호장 */
export function curvatures(x: Float64Array, z: Float64Array, s: Float64Array, tx: Float64Array, tz: Float64Array, win: number): Float64Array {
  const n = x.length, k = new Float64Array(n);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    while (a < i && s[i] - s[a] > win) a++;
    if (b < i) b = i;
    while (b < n - 1 && s[b] - s[i] < win) b++;
    const ds = s[b] - s[a];
    if (ds < EPS) continue;
    const ang = wrapPi(Math.atan2(tz[b], tx[b]) - Math.atan2(tz[a], tx[a]));
    k[i] = ang / ds;
  }
  return k;
}

// ───────── 선분·다각형 ─────────
export interface Hit { t: number; u: number; x: number; z: number }
/** 선분 a→b 와 c→d 의 교차. 매개변수 허용오차 tol (끝점 접촉 포함) */
export function segIntersect(a: P2, b: P2, c: P2, d: P2, tol = 1e-9): Hit | null {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return null;
  return {t, u, x: a[0] + rx * t, z: a[1] + rz * t};
}
/** 직선 o1+t*d1 과 o2+u*d2 의 교점 매개변수 (평행이면 null) */
export function lineIntersect(o1: P2, d1: P2, o2: P2, d2: P2): {t: number; u: number} | null {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const qx = o2[0] - o1[0], qz = o2[1] - o1[1];
  return {t: (qx * d2[1] - qz * d2[0]) / den, u: (qx * d1[1] - qz * d1[0]) / den};
}
/** 부호 있는 면적 (x,z 평면에서 x→z 로 도는 방향이 +) */
export function signedArea(p: P2[]): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) { const q = p[(i + 1) % n]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return a / 2;
}
export const polygonArea = (p: P2[]): number => Math.abs(signedArea(p));
export function pointInPolygon(x: number, z: number, p: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const zi = p[i][1], zj = p[j][1];
    if (zi > z !== zj > z && x < ((p[j][0] - p[i][0]) * (z - zi)) / (zj - zi) + p[i][0]) inside = !inside;
  }
  return inside;
}
export function polygonCentroid(p: P2[]): P2 {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n], f = p[i][0] * q[1] - q[0] * p[i][1];
    a += f; cx += (p[i][0] + q[0]) * f; cz += (p[i][1] + q[1]) * f;
  }
  if (Math.abs(a) < EPS) { const m = p.reduce((s, v) => [s[0] + v[0], s[1] + v[1]], [0, 0]); return [m[0] / p.length, m[1] / p.length]; }
  return [cx / (3 * a), cz / (3 * a)];
}
export function distPointSeg(px: number, pz: number, a: P2, b: P2): number {
  return distToChord([px, pz], a, b);
}
export function distToPolyline(px: number, pz: number, pts: P2[]): number {
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) m = Math.min(m, distToChord([px, pz], pts[i - 1], pts[i]));
  return m;
}

/** 자기 교차 고리 제거: 비인접 선분이 교차하면 사이 꼭짓점을 교점 하나로 바꾼다. closed 면 다각형 */
export function trimLoops(pts: P2[], closed: boolean): P2[] {
  let p = pts.slice();
  for (let pass = 0; pass < 64; pass++) {
    const n = p.length, segN = closed ? n : n - 1;
    let found = false;
    for (let i = 0; i < segN && !found; i++) {
      for (let j = i + 2; j < segN; j++) {
        if (closed && i === 0 && j === segN - 1) continue;
        const h = segIntersect(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n], -1e-9);
        if (!h) continue;
        const q: P2 = [h.x, h.z];
        p = p.slice(0, i + 1).concat([q], p.slice(j + 1));
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  return p;
}

/** 꺾은선 평행 이동 (d>0 = 오른쪽 nR). 꺾임은 마이터(한계 miter 배), 한계 초과는 깎기. 안쪽 꼬임은 trimLoops 로 정리 */
export function offsetPolyline(pts: P2[], d: number, miter = 2.5): P2[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const dirs: P2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = hyp(dx, dz) || 1;
    dirs.push([dx / l, dz / l]);
  }
  const out: P2[] = [[pts[0][0] - dirs[0][1] * d, pts[0][1] + dirs[0][0] * d]];
  for (let i = 1; i < n - 1; i++) {
    const a = dirs[i - 1], b = dirs[i];
    const na: P2 = [-a[1], a[0]], nb: P2 = [-b[1], b[0]];
    const mx = na[0] + nb[0], mz = na[1] + nb[1], ml = hyp(mx, mz);
    if (ml < 1e-6) { out.push([pts[i][0] + na[0] * d, pts[i][1] + na[1] * d]); continue; }
    const cosH = ml / 2; // cos(꺾임각/2)
    const k = 1 / cosH;
    if (k > miter) {
      out.push([pts[i][0] + na[0] * d, pts[i][1] + na[1] * d], [pts[i][0] + nb[0] * d, pts[i][1] + nb[1] * d]);
    } else out.push([pts[i][0] + (mx / ml) * d * k, pts[i][1] + (mz / ml) * d * k]);
  }
  const L = dirs[n - 2];
  out.push([pts[n - 1][0] - L[1] * d, pts[n - 1][1] + L[0] * d]);
  return trimLoops(out, false);
}
/** 다각형 팽창(d>0 바깥, d<0 안쪽). 방향(CW/CCW)에 무관. 결과 면적 부호가 뒤집히면 빈 배열 */
export function offsetPolygon(poly: P2[], d: number, miter = 2.5): P2[] {
  const n = poly.length;
  if (n < 3) return [];
  const sgn = signedArea(poly) >= 0 ? 1 : -1, off = -d * sgn; // 바깥 = 면적 부호의 반대쪽 법선
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = poly[(i + n - 1) % n], c = poly[i], q = poly[(i + 1) % n];
    const ax = c[0] - p[0], az = c[1] - p[1], al = hyp(ax, az) || 1, bx = q[0] - c[0], bz = q[1] - c[1], bl = hyp(bx, bz) || 1;
    const na: P2 = [-az / al, ax / al], nb: P2 = [-bz / bl, bx / bl];
    const mx = na[0] + nb[0], mz = na[1] + nb[1], ml = hyp(mx, mz);
    if (ml < 1e-6) { out.push([c[0] + na[0] * off, c[1] + na[1] * off]); continue; }
    const k = 2 / ml;
    if (k > miter) out.push([c[0] + na[0] * off, c[1] + na[1] * off], [c[0] + nb[0] * off, c[1] + nb[1] * off]);
    else out.push([c[0] + (mx / ml) * off * k, c[1] + (mz / ml) * off * k]);
  }
  const res = trimLoops(out, true);
  return res.length >= 3 && signedArea(res) * sgn > 0 ? res : [];
}
export const insetPolygon = (poly: P2[], d: number, miter = 2.5): P2[] => offsetPolygon(poly, -d, miter);

/** 귀 자르기 삼각분할 → 꼭짓점 인덱스 3개씩. 단순 다각형(구멍 없음) 전용, 꼭짓점 수가 작을 때 쓴다 */
export function triangulatePolygon(poly: P2[]): number[] {
  const n = poly.length, idx = poly.map((_, i) => i), out: number[] = [];
  if (n < 3) return out;
  const sgn = signedArea(poly) >= 0 ? 1 : -1;
  const cross = (a: P2, b: P2, c: P2) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * sgn;
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (cross(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = poly[j];
        if (cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) { idx.splice(0, 1); } // 퇴화 입력: 한 점 버리고 계속
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

// ───────── 공간 해시 ─────────
export class SpatialHash<T> {
  private cells = new Map<number, T[]>();
  constructor(readonly cell: number) {}
  private key(i: number, j: number): number { return (i + 32768) * 65536 + (j + 32768); }
  insert(x0: number, z0: number, x1: number, z1: number, v: T): void {
    const i0 = Math.floor(Math.min(x0, x1) / this.cell), i1 = Math.floor(Math.max(x0, x1) / this.cell);
    const j0 = Math.floor(Math.min(z0, z1) / this.cell), j1 = Math.floor(Math.max(z0, z1) / this.cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j);
      const a = this.cells.get(k);
      if (a) a.push(v); else this.cells.set(k, [v]);
    }
  }
  /** 사각 범위와 겹치는 칸의 항목들 (중복 가능 — 호출자가 Set 으로 거른다). 칸 순서는 결정적 */
  query(x0: number, z0: number, x1: number, z1: number): T[] {
    const out: T[] = [];
    const i0 = Math.floor(Math.min(x0, x1) / this.cell), i1 = Math.floor(Math.max(x0, x1) / this.cell);
    const j0 = Math.floor(Math.min(z0, z1) / this.cell), j1 = Math.floor(Math.max(z0, z1) / this.cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = this.cells.get(this.key(i, j)); if (a) for (const v of a) out.push(v); }
    return out;
  }
}
