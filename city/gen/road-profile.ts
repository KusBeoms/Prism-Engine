// 도로 종단(세로 단면) 풀이. 순수 함수. 모드: 0 = 지형 추종(자유), 1 = 명시 높이(HeightKey), 2 = 키 없는 구조물(양 끝 사이 직선).
// 규칙: 명시 구간은 키 사이를 직선 보간한 뒤 연직 곡선용 이동평균만 적용(끝점 고정, 경사 최대값 비증가). 자유 구간은 지형을 평활 →
// 양 끝 고정점과 이음 → 등급 최대 경사로 앞뒤 제한 → 한 번 더 평활. 최대 경사 위반은 여기서 조용히 고치지 않고 gradeReport 로 보고한다.
import {clamp, smooth01} from './geom.js';
import type {HeightKey} from '../city-schema.js';

export interface ProfileInput {
  s: Float64Array;
  /** 표본마다 모드 0/1/2 */
  mode: Uint8Array;
  /** 모드 1 표본의 명시 높이(그 외 무시) */
  fixedY: Float64Array;
  /** 표본 위치의 (도로 반영 전) 지형 높이 */
  terrainY: Float64Array;
  maxGrade: number;
  /** 지형 평활 창(m) */
  terrainWin: number;
  /** 명시 구간 연직 곡선 창(m) */
  curveWin: number;
}
export interface ProfileResult {
  y: Float64Array;
  /** 지형 추종 구간에서 최대 |도로 - 지형| (절토·성토 깊이 척도) */
  earthwork: number;
  /** 등급 제한이 실제로 작동한 길이(m) */
  limitedLen: number;
}

/** 키 보간: 키 밖은 끝값 유지 */
export function keyY(keys: HeightKey[], s: number): number {
  if (s <= keys[0].s) return keys[0].y;
  const n = keys.length;
  if (s >= keys[n - 1].s) return keys[n - 1].y;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m].s <= s) lo = m; else hi = m; }
  const f = (s - keys[lo].s) / (keys[hi].s - keys[lo].s || 1);
  return keys[lo].y + (keys[hi].y - keys[lo].y) * f;
}

/** 이동평균. [a,b] 구간만 바꾸고 경계는 반사로 채운다. 반사 피벗 pl/pr 은 배열 인덱스(구간 밖일 수 있음) */
function boxRun(y: Float64Array, a: number, b: number, m: number, leftOdd: boolean, rightOdd: boolean, pl: number, pr: number): Float64Array {
  const out = Float64Array.from(y);
  if (m < 1) return out;
  const get = (j: number): number => {
    if (j < a) { if (leftOdd) return 2 * y[pl] - y[Math.min(2 * pl - j, b)]; return y[Math.min(2 * a - j, b)]; }
    if (j > b) { if (rightOdd) return 2 * y[pr] - y[Math.max(2 * pr - j, a)]; return y[Math.max(2 * b - j, a)]; }
    return y[j];
  };
  for (let i = a; i <= b; i++) {
    let sum = 0;
    for (let j = i - m; j <= i + m; j++) sum += get(j);
    out[i] = sum / (2 * m + 1);
  }
  return out;
}
function runs(mode: Uint8Array, want: number): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < mode.length) {
    if (mode[i] !== want) { i++; continue; }
    let j = i;
    while (j + 1 < mode.length && mode[j + 1] === want) j++;
    out.push([i, j]);
    i = j + 1;
  }
  return out;
}

export function solveProfile(inp: ProfileInput): ProfileResult {
  const {s, mode, fixedY, terrainY} = inp, n = s.length;
  const ds = n > 1 ? (s[n - 1] - s[0]) / (n - 1) : 1, win = (w: number) => Math.max(0, Math.round(w / 2 / ds));
  let y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = mode[i] === 1 ? fixedY[i] : terrainY[i];
  // 1) 명시 구간 연직 곡선 (끝점 고정)
  for (const [a, b] of runs(mode, 1)) {
    if (b - a < 2) continue;
    const m = Math.min(win(inp.curveWin), Math.floor((b - a) / 2));
    const sm = boxRun(y, a, b, m, true, true, a, b);
    for (let i = a; i <= b; i++) y[i] = sm[i];
  }
  // 2) 자유 구간
  let limitedLen = 0, earthwork = 0;
  for (const [a, b] of runs(mode, 0)) {
    const hasL = a > 0 && mode[a - 1] === 1, hasR = b < n - 1 && mode[b + 1] === 1;
    const raw = Float64Array.from(terrainY);
    let u = boxRun(raw, a, b, win(inp.terrainWin), false, false, a, b);
    const len = s[b] - s[a], Lb = Math.max(1, Math.min(Math.max(40, inp.terrainWin), len));
    const dl = hasL ? y[a - 1] - u[a] : 0, dr = hasR ? y[b + 1] - u[b] : 0;
    for (let i = a; i <= b; i++) u[i] += dl * (1 - smooth01((s[i] - s[a]) / Lb)) + dr * (1 - smooth01((s[b] - s[i]) / Lb));
    // 등급 제한 (앞→뒤, 뒤→앞). 끝 고정점은 건드리지 않는다
    const g = inp.maxGrade * 0.97, pre = Float64Array.from(u);
    const lo = hasL ? a - 1 : a, hi = hasR ? b + 1 : b;
    const w = Float64Array.from(u);
    if (hasL) w[a - 1] = y[a - 1];
    if (hasR) w[b + 1] = y[b + 1];
    for (let i = lo + 1; i <= b; i++) w[i] = clamp(w[i], w[i - 1] - g * (s[i] - s[i - 1]), w[i - 1] + g * (s[i] - s[i - 1]));
    for (let i = hi - 1; i >= a; i--) w[i] = clamp(w[i], w[i + 1] - g * (s[i + 1] - s[i]), w[i + 1] + g * (s[i + 1] - s[i]));
    for (let i = a; i <= b; i++) { if (Math.abs(w[i] - pre[i]) > 1e-6 && i > a) limitedLen += s[i] - s[i - 1]; u[i] = w[i]; }
    // 한 번 더 평활 (고정점 쪽은 피벗 반사)
    const m2 = Math.min(win(20), Math.floor((b - a) / 2));
    if (hasL) u[a - 1] = y[a - 1];
    if (hasR) u[b + 1] = y[b + 1];
    u = boxRun(u, a, b, m2, hasL, hasR, hasL ? a - 1 : a, hasR ? b + 1 : b);
    for (let i = a; i <= b; i++) { y[i] = u[i]; earthwork = Math.max(earthwork, Math.abs(u[i] - terrainY[i])); }
  }
  // 3) 키 없는 구조물: 양쪽 풀이값 사이 직선
  for (const [a, b] of runs(mode, 2)) {
    const ya = a > 0 ? y[a - 1] : b < n - 1 ? y[b + 1] : y[a], yb = b < n - 1 ? y[b + 1] : ya, sa = a > 0 ? s[a - 1] : s[a], sb = b < n - 1 ? s[b + 1] : s[b];
    for (let i = a; i <= b; i++) y[i] = sb > sa ? ya + ((yb - ya) * (s[i] - sa)) / (sb - sa) : ya;
  }
  return {y, earthwork, limitedLen};
}

export interface GradeViolation { s: number; grade: number }
/** 표본별 종단 경사(중앙 차분, ±span 표본) */
export function gradesOf(s: Float64Array, y: Float64Array, span = 2): Float64Array {
  const n = s.length, g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - span), b = Math.min(n - 1, i + span);
    g[i] = s[b] > s[a] ? (y[b] - y[a]) / (s[b] - s[a]) : 0;
  }
  return g;
}
/** 등급 한도(허용오차 tol 배)를 넘는 최악 위치. 없으면 null */
export function gradeViolation(s: Float64Array, g: Float64Array, maxGrade: number, tol = 1.02): GradeViolation | null {
  let worst: GradeViolation | null = null;
  for (let i = 0; i < g.length; i++) {
    const a = Math.abs(g[i]);
    if (a > maxGrade * tol + 1e-4 && (!worst || a > Math.abs(worst.grade))) worst = {s: s[i], grade: g[i]};
  }
  return worst;
}
