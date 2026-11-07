// 도로 리본: 도로 조각(교차로 트림 사이)을 단면 슬라이스로 풀어 표면별 메시로 낸다. 교차로 포장·보도 모서리·횡단보도도 여기서 메시가 된다.
// y 는 확정 종단 + 표면 오프셋(연석 0.15, 표시 0.012). 좌표 규칙: 가로 위치 lat>0 = 오른쪽(nR). uv = (가로m 또는 높이m, 도로 누적 s m), 교차로 포장은 (x, z).
import {SCALE} from '../city-schema.js';
import {lerp} from './geom.js';
import {MeshSet} from './ribbon-mesh.js';
import type {Orient, V5} from './ribbon-mesh.js';
import {KIND_CODE, SEC, locate, pointAt, sideEdges, thinIndices, DEFAULT_THIN} from './roads.js';
import type {RoadGeo, ThinTol} from './roads.js';
import type {Cluster} from './junctions.js';
import type {JunctionGeom, V3} from './junction-geom.js';
import {sampleBilinear} from './terrain.js';
import type {Terrain} from './terrain.js';

export const MARK_Y = 0.012;
export const DASH = {len: 3, period: 9};
const DECK_T = 0.8;

export interface Piece { ri: number; sa: number; sb: number; capA: boolean; capB: boolean }
export interface Slice {
  s: number; x: number; y: number; z: number; tx: number; tz: number; sec: number[]; kappa: number; kind: number; layer: number;
}
/** 도로별 제외 구간(교차로 트림)을 빼고 남은 조각 목록 */
export function roadPieces(roads: RoadGeo[], clusters: Cluster[]): Piece[] {
  const cut: {s0: number; s1: number}[][] = roads.map(() => []);
  const touched: [boolean, boolean][] = roads.map(() => [false, false]);
  for (const c of clusters) {
    // 통과 도로: 두 팔의 트림을 합친 구간 / 끝 도로: 한쪽 구간
    const by = new Map<number, {back: number; fwd: number; s: number}>();
    for (const a of c.arms) {
      const e = by.get(a.ri) ?? {back: 0, fwd: 0, s: a.sNode};
      if (a.dir === 1) e.fwd = a.trim; else e.back = a.trim;
      by.set(a.ri, e);
    }
    for (const [ri, e] of by) {
      if (e.back === 0 && e.fwd === 0) continue;
      const r = roads[ri];
      cut[ri].push({s0: e.s - e.back, s1: e.s + e.fwd});
      if (e.s - e.back <= 0.01) touched[ri][0] = true;
      if (e.s + e.fwd >= r.length - 0.01) touched[ri][1] = true;
    }
  }
  const out: Piece[] = [];
  roads.forEach((r, ri) => {
    const cs = cut[ri].sort((a, b) => a.s0 - b.s0);
    const merged: {s0: number; s1: number}[] = [];
    for (const c of cs) { const l = merged[merged.length - 1]; if (l && c.s0 <= l.s1) l.s1 = Math.max(l.s1, c.s1); else merged.push({...c}); }
    let cur = 0;
    for (const m of merged) { if (m.s0 - cur > 0.3) out.push({ri, sa: cur, sb: m.s0, capA: cur === 0 && !touched[ri][0], capB: false}); cur = Math.max(cur, m.s1); }
    if (r.length - cur > 0.3) out.push({ri, sa: cur, sb: r.length, capA: cur === 0 && !touched[ri][0], capB: !touched[ri][1]});
  });
  return out;
}

function sliceAt(r: RoadGeo, s: number): Slice {
  const p = pointAt(r, s), {i, f} = locate(r, s), j = Math.min(i + 1, r.n - 1);
  return {s: p.s, x: p.x, y: p.y, z: p.z, tx: p.tx, tz: p.tz, sec: p.sec, kappa: lerp(r.kappa[i], r.kappa[j], f), kind: KIND_CODE[r.segs[p.seg].kind], layer: r.segs[p.seg].layer};
}
/** 조각 [sa,sb] 의 슬라이스: 양 끝은 정확히 sa/sb, 사이는 솎은 조밀 표본 */
export function pieceSlices(r: RoadGeo, sa: number, sb: number, tol: ThinTol): Slice[] {
  const ia = locate(r, sa).i, ib = Math.min(r.n - 1, locate(r, sb).i + 1);
  const out: Slice[] = [sliceAt(r, sa)];
  for (const k of thinIndices(r, ia, ib, tol)) if (r.s[k] > sa + 0.2 && r.s[k] < sb - 0.2) out.push(sliceAt(r, r.s[k]));
  out.push(sliceAt(r, sb));
  return out;
}
/** 가로 위치 lat 의 월드 점. 안쪽 급커브에서는 곡률 반경의 0.8 로 제한해 꼬임을 막는다 */
function latPt(sl: Slice, lat: number, dy: number, uvu: number): V5 {
  let l = lat;
  const k = sl.kappa;
  if (Math.abs(k) > 1e-4) { const lim = 0.8 / Math.abs(k); if ((k > 0 && l > 0) || (k < 0 && l < 0)) l = Math.sign(l) * Math.min(Math.abs(l), lim); }
  return [sl.x - sl.tz * l, sl.y + dy, sl.z + sl.tx * l, uvu, sl.s];
}

interface Lines { l: number[]; r: number[]; walkL: number; walkR: number; med: number; medRaised: boolean; one: boolean }
const linesOf = (sec: number[]): Lines => {
  const L = sideEdges(sec, 0, false), R = sideEdges(sec, 0, true);
  return {l: [L.e0, L.e1, L.e2, L.e3, L.e4], r: [R.e0, R.e1, R.e2, R.e3, R.e4], walkL: sec[SEC.walk], walkR: sec[SEC.walk], med: sec[SEC.med], medRaised: sec[SEC.med] >= 1.0, one: sec[SEC.oneWay] > 0.5};
};

export interface RibbonCtx { mesh: MeshSet; terrain: Terrain; tol: ThinTol }

/** 한 조각의 표면 메시 */
export function emitPiece(ctx: RibbonCtx, r: RoadGeo, pc: Piece): void {
  const sl = pieceSlices(r, pc.sa, pc.sb, ctx.tol), m = ctx.mesh, H = SCALE.curbH;
  const band = (surface: Parameters<MeshSet['quad']>[1], a: Slice, b: Slice, la: number, lb: number, ra: number, rb: number, dy: number, o: Orient = 'up') => {
    // 슬라이스 a→b 에서 가로 [la..ra] → [lb..rb] 띠
    if (Math.abs(ra - la) < 1e-4 && Math.abs(rb - lb) < 1e-4) return;
    m.quad(a.layer, surface, latPt(a, la, dy, la), latPt(a, ra, dy, ra), latPt(b, lb, dy, lb), latPt(b, rb, dy, rb), o);
  };
  const wall = (surface: Parameters<MeshSet['quad']>[1], a: Slice, b: Slice, la: number, lb: number, y0a: number, y1a: number, y0b: number, y1b: number, o: Orient) => {
    const p = (s: Slice, lat: number, dy: number, v: number): V5 => { const q = latPt(s, lat, dy, v); return q; };
    m.quad(a.layer, surface, p(a, la, y0a, y0a), p(a, la, y1a, y1a), p(b, lb, y0b, y0b), p(b, lb, y1b, y1b), o);
  };
  for (let i = 0; i + 1 < sl.length; i++) {
    const a = sl[i], b = sl[i + 1], A = linesOf(a.sec), B = linesOf(b.sec);
    const nA = a.sec[SEC.lanesN], nB = b.sec[SEC.lanesN];
    // 차도: 가운데(비-돌출 분리대 포함) ~ 주차대 끝 (또는 분리대 바깥 ~ 주차대 끝)
    if (A.medRaised || B.medRaised) {
      band('asphalt', a, b, -A.l[2], -B.l[2], -A.l[0], -B.l[0], 0); band('asphalt', a, b, A.r[0], B.r[0], A.r[2], B.r[2], 0);
      band('median', a, b, -A.l[0], -B.l[0], A.r[0], B.r[0], H);
      wall('curb', a, b, -A.l[0], -B.l[0], 0, H, 0, H, [a.tz, -a.tx]);
      wall('curb', a, b, A.r[0], B.r[0], 0, H, 0, H, [-a.tz, a.tx]);
    } else band('asphalt', a, b, -A.l[2], -B.l[2], A.r[2], B.r[2], 0);
    // 갓길
    band('shoulder', a, b, -A.l[3], -B.l[3], -A.l[2], -B.l[2], 0); band('shoulder', a, b, A.r[2], B.r[2], A.r[3], B.r[3], 0);
    // 보도 + 연석 면
    if (A.walkL > 0.01 || B.walkL > 0.01) {
      band('sidewalk', a, b, -A.l[4], -B.l[4], -A.l[3], -B.l[3], H); band('sidewalk', a, b, A.r[3], B.r[3], A.r[4], B.r[4], H);
      wall('curb', a, b, -A.l[3], -B.l[3], 0, H, 0, H, [-a.tz, a.tx]);
      wall('curb', a, b, A.r[3], B.r[3], 0, H, 0, H, [a.tz, -a.tx]);
    }
    // 표시
    markings(m, a, b, A, B, nA, nB);
    // 교량·램프 상판 두께
    const k = a.kind === 1 || a.kind === 3, k2 = b.kind === 1 || b.kind === 3;
    if (k && k2) deckSlab(ctx, a, b, A, B);
  }
  // 상판 끝 면, 도로 끝 마감
  for (let i = 0; i < sl.length; i++) {
    const a = sl[i], deck = (s: Slice) => s.kind === 1 || s.kind === 3;
    if (!deck(a)) continue;
    const prev = i > 0 ? sl[i - 1] : null, next = i + 1 < sl.length ? sl[i + 1] : null;
    if ((!prev || !deck(prev)) && (i === 0 ? pc.capA : true)) endFace(ctx, a, -1);
    if ((!next || !deck(next)) && (i === sl.length - 1 ? pc.capB : true)) endFace(ctx, a, 1);
  }
  if (pc.capA) capEnd(ctx, sl[0], -1);
  if (pc.capB) capEnd(ctx, sl[sl.length - 1], 1);
}

function markings(m: MeshSet, a: Slice, b: Slice, A: Lines, B: Lines, nA: number, nB: number): void {
  const y = MARK_Y, w = 0.12;
  const strip = (la: number, lb: number) => m.quad(a.layer, 'marking', latPt(a, la - w / 2, y, la), latPt(a, la + w / 2, y, la), latPt(b, lb - w / 2, y, lb), latPt(b, lb + w / 2, y, lb), 'up');
  // 노란 이중 중앙선: 분리대 없는 양방향
  if (!A.one && !A.medRaised && !B.one && !B.medRaised) { const g = Math.max(0.15, A.med / 2 + 0.1), g2 = Math.max(0.15, B.med / 2 + 0.1); strip(-g, -g2); strip(g, g2); }
  // 주차대/갓길 경계 실선
  if (A.r[2] > A.r[1] + 0.01 && B.r[2] > B.r[1] + 0.01) strip(A.r[1], B.r[1]);
  if (A.l[2] > A.l[1] + 0.01 && B.l[2] > B.l[1] + 0.01) strip(-A.l[1], -B.l[1]);
  if (A.r[3] > A.r[2] + 0.01 && B.r[3] > B.r[2] + 0.01) strip(A.r[2] - 0.1, B.r[2] - 0.1);
  if (A.l[3] > A.l[2] + 0.01 && B.l[3] > B.l[2] + 0.01) strip(-A.l[2] + 0.1, -B.l[2] + 0.1);
  // 같은 방향 차로 구분 점선: 전역 s 위상 (period 마다 len 길이)
  const n = Math.min(nA, nB), pos = (L: Lines, N: number): number[] => {
    const o: number[] = [];
    for (let k = 1; k < n; k++) {
      if (L.one) o.push(-L.r[1] + (2 * L.r[1] * k) / N);
      else { o.push(-(L.l[0] + ((L.l[1] - L.l[0]) * k) / N)); o.push(L.r[0] + ((L.r[1] - L.r[0]) * k) / N); }
    }
    return o;
  };
  const pa = pos(A, nA), pb = pos(B, nB);
  for (let q = 0; q < pa.length; q++) {
    for (let d0 = Math.floor(a.s / DASH.period) * DASH.period; d0 < b.s; d0 += DASH.period) {
      const s0 = Math.max(d0, a.s), s1 = Math.min(d0 + DASH.len, b.s);
      if (s1 - s0 < 0.2) continue;
      const span = b.s - a.s || 1, f0 = (s0 - a.s) / span, f1 = (s1 - a.s) / span;
      const pt = (f: number, lat: number): [V5, V5] => {
        const tx = a.tx + (b.tx - a.tx) * f, tz = a.tz + (b.tz - a.tz) * f, l = Math.hypot(tx, tz) || 1, nx = -tz / l, nz = tx / l;
        const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f, yy = a.y + (b.y - a.y) * f + y, s = a.s + span * f;
        return [[x + nx * (lat - w / 2), yy, z + nz * (lat - w / 2), lat, s], [x + nx * (lat + w / 2), yy, z + nz * (lat + w / 2), lat, s]];
      };
      const [p0, p1] = pt(f0, pa[q] + (pb[q] - pa[q]) * f0), [q0, q1] = pt(f1, pa[q] + (pb[q] - pa[q]) * f1);
      m.quad(a.layer, 'marking', p0, p1, q0, q1, 'up');
    }
  }
}

function deckSlab(ctx: RibbonCtx, a: Slice, b: Slice, A: Lines, B: Lines): void {
  const th = (s: Slice) => (s.kind === 1 ? DECK_T : Math.min(DECK_T, Math.max(0, s.y - sampleBilinear(ctx.terrain, s.x, s.z) - 0.05)));
  const ta = th(a), tb = th(b), m = ctx.mesh, H = SCALE.curbH;
  if (ta < 0.05 && tb < 0.05) return;
  const oa = Math.max(A.l[A.walkL > 0.01 ? 4 : 3], 0), ob = Math.max(B.l[B.walkL > 0.01 ? 4 : 3], 0), pa = A.r[A.walkR > 0.01 ? 4 : 3], pb = B.r[B.walkR > 0.01 ? 4 : 3];
  void H;
  m.quad(a.layer, 'deck', latPt(a, -oa, -ta, -oa), latPt(a, pa, -ta, pa), latPt(b, -ob, -tb, -ob), latPt(b, pb, -tb, pb), 'down');
  const wallQ = (la: number, lb: number, o: Orient) => m.quad(a.layer, 'deck', latPt(a, la, -ta, 0), latPt(a, la, A.walkL > 0.01 ? SCALE.curbH : 0, 1), latPt(b, lb, -tb, 0), latPt(b, lb, B.walkL > 0.01 ? SCALE.curbH : 0, 1), o);
  wallQ(-oa, -ob, [a.tz, -a.tx]);
  wallQ(pa, pb, [-a.tz, a.tx]);
}
function endFace(ctx: RibbonCtx, a: Slice, dir: 1 | -1): void {
  const A = linesOf(a.sec), th = a.kind === 1 ? DECK_T : Math.min(DECK_T, Math.max(0, a.y - sampleBilinear(ctx.terrain, a.x, a.z) - 0.05));
  if (th < 0.05) return;
  const o = A.l[A.walkL > 0.01 ? 4 : 3], p = A.r[A.walkR > 0.01 ? 4 : 3], top = A.walkL > 0.01 ? SCALE.curbH : 0;
  ctx.mesh.quad(a.layer, 'deck', latPt(a, -o, -th, 0), latPt(a, -o, top, 1), latPt(a, p, -th, 0), latPt(a, p, top, 1), [a.tx * dir, a.tz * dir]);
}
/** 도로 끝(교차로 없음): 포장 끝 연석 면 + 보도 마감 띠 */
function capEnd(ctx: RibbonCtx, a: Slice, dir: 1 | -1): void {
  const A = linesOf(a.sec), m = ctx.mesh, H = SCALE.curbH, e3 = [A.l[3], A.r[3]], ew = a.sec[SEC.walk];
  const at = (lat: number, t: number, dy: number): V5 => { const q = latPt(a, lat, dy, lat); return [q[0] + a.tx * t * dir, q[1], q[2] + a.tz * t * dir, lat, a.s]; };
  if (ew > 0.01) {
    m.quad(a.layer, 'curb', at(-e3[0], 0, 0), at(-e3[0], 0, H), at(e3[1], 0, 0), at(e3[1], 0, H), [-a.tx * dir, -a.tz * dir]);
    m.quad(a.layer, 'sidewalk', at(-A.l[4], 0, H), at(A.r[4], 0, H), at(-A.l[4], ew, H), at(A.r[4], ew, H), 'up');
  }
}

/** 교차로 포장·보도 모서리·연석·횡단보도·정지선·섬 */
export function emitJunction(ctx: RibbonCtx, g: JunctionGeom): void {
  const m = ctx.mesh, H = SCALE.curbH, L = g.layer;
  const v = (x: number, y: number, z: number, u = x, w = z): V5 => [x, y, z, u, w];
  for (let i = 0; i + 8 < g.pave.length; i += 9) m.tri(L, 'asphalt', v(g.pave[i], g.pave[i + 1], g.pave[i + 2]), v(g.pave[i + 3], g.pave[i + 4], g.pave[i + 5]), v(g.pave[i + 6], g.pave[i + 7], g.pave[i + 8]), 'up');
  for (const b of g.bands) {
    const n = b.inner.length;
    for (let i = 0; i + 1 < n; i++) {
      const a0 = b.inner[i], a1 = b.inner[i + 1], o0 = b.outer[i], o1 = b.outer[i + 1];
      m.quad(L, 'sidewalk', v(a0[0], a0[1] + H, a0[2]), v(o0[0], o0[1] + H, o0[2]), v(a1[0], a1[1] + H, a1[2]), v(o1[0], o1[1] + H, o1[2]), 'up');
      const nx = (g.x - (a0[0] + a1[0]) / 2), nz = (g.z - (a0[2] + a1[2]) / 2);
      m.quad(L, 'curb', v(a0[0], a0[1], a0[2], 0, 0), v(a0[0], a0[1] + H, a0[2], H, 0), v(a1[0], a1[1], a1[2], 0, 1), v(a1[0], a1[1] + H, a1[2], H, 1), [nx, nz]);
    }
  }
  for (const q of g.crosswalks) m.quad(L, 'crosswalk', v(...q[0]), v(...q[1]), v(...q[3]), v(...q[2]), 'up');
  for (const q of g.stops) m.quad(L, 'marking', v(...q[0]), v(...q[1]), v(...q[3]), v(...q[2]), 'up');
  if (g.island) {
    const {cx, cz, r, y} = g.island, n = 24;
    for (let i = 0; i < n; i++) {
      const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n;
      const p0 = v(cx + r * Math.cos(a0), y + H, cz + r * Math.sin(a0)), p1 = v(cx + r * Math.cos(a1), y + H, cz + r * Math.sin(a1));
      m.tri(L, 'median', v(cx, y + H, cz), p0, p1, 'up');
      m.quad(L, 'curb', v(p0[0], y, p0[2]), p0, v(p1[0], y, p1[2]), p1, [p0[0] - cx, p0[2] - cz]);
    }
  }
}
export type { V3 };
export { DEFAULT_THIN };
