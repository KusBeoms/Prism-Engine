// 필지(대지) 생성·검증 + 건물 대지 평탄화(pad).
// 대지 = 도로 한쪽에 접한 직사각형(전면 폭 w = 도로 방향 현, 깊이 d). 자동 필지 생성(구간 차감·채움·뒷줄)은 lotpack.ts, 여기는 한 칸의 검증과 명시 필지.
// 거부 사유(코드): slope, altitude, outside-bounds, no-build, junction-reserve, road-overlap, lot-overlap, sight-axis. 구역 밖은 조용히 건너뛴다(통계만).
import type {BuildingStyle, ParcelSource} from '../city-schema.js';
import {distPointSeg, pointInPolygon} from './geom.js';
import type {P2} from './geom.js';
import {obbOverlap, corners, toLocal, aabbOf} from './obb.js';
import type {Obb} from './obb.js';
import type {PlaceCtx} from './place-ctx.js';
import type {Lot, PadRec} from './place-types.js';
import {sightAxesOf} from './sight.js';
import {pointAt, sideEdges} from './roads.js';
import {siteReport} from './terrain.js';
import type {Terrain} from './terrain.js';

export const JUNCTION_RESERVE = 0.5;
export const LOT_FRONT_GAP = 0.3;
export interface LotRej { owner: string; code: string; msg: string }
const RAD = Math.PI / 180;

/** 대지 박스의 rot: 로컬 +x = u(전면 방향) → (cosθ, -sinθ) = (ux, uz) → θ = atan2(-uz, ux) */
export const rotOfU = (l: {ux: number; uz: number}): number => Math.atan2(-l.uz, l.ux) / RAD;
export const lotObb = (l: Lot): Obb => ({cx: l.cx, cz: l.cz, hw: l.w / 2, hd: l.d / 2, rot: rotOfU(l)});

export interface Frame { cx: number; cz: number; ux: number; uz: number; vx: number; vz: number; w: number; lat0: number; sMid: number }
export function lotFrame(ctx: PlaceCtx, ri: number, side: 'left' | 'right', s0: number, s1: number, depth: number): Frame | null {
  const r = ctx.roads[ri], right = side === 'right';
  const A = pointAt(r, s0), B = pointAt(r, s1), M = pointAt(r, (s0 + s1) / 2);
  let ux = B.x - A.x, uz = B.z - A.z;
  const w = Math.hypot(ux, uz);
  if (w < 1) return null;
  ux /= w; uz /= w;
  const vx = right ? -uz : uz, vz = right ? ux : -ux;
  const e = (p: ReturnType<typeof pointAt>) => sideEdges(p.sec, 0, right).e5;
  const cmx = (A.x + B.x) / 2, cmz = (A.z + B.z) / 2, sag = (M.x - cmx) * vx + (M.z - cmz) * vz;
  const lat0 = Math.max(e(A), e(B), sag + e(M)) + LOT_FRONT_GAP;
  return {cx: cmx + vx * (lat0 + depth / 2), cz: cmz + vz * (lat0 + depth / 2), ux, uz, vx, vz, w, lat0, sMid: (s0 + s1) / 2};
}
/** 대지 표본점: 중심·모서리·변 중점·전면 1/4 점 */
export function lotSamples(l: {cx: number; cz: number; ux: number; uz: number; vx: number; vz: number; w: number; d: number}, inset = 0, skipFront = false): P2[] {
  const hw = l.w / 2 - inset, hd = l.d / 2 - inset, out: P2[] = [];
  for (const a of [-1, 0, 1]) for (const b of skipFront ? [0, 1] : [-1, 0, 1]) out.push([l.cx + l.ux * hw * a + l.vx * hd * b, l.cz + l.uz * hw * a + l.vz * hd * b]);
  if (!skipFront) for (const a of [-0.5, 0.5]) out.push([l.cx + l.ux * hw * a - l.vx * hd, l.cz + l.uz * hw * a - l.vz * hd]);
  return out;
}
const bboxOf = (p: P2[]): [number, number, number, number] => { const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]; for (const q of p) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); } return b; };

/** 대지 한 칸의 도로·교차로·경계·예외·겹침 검사. 통과하면 null, 아니면 {code,msg}. needBuildable 이면 전면 제외 표본이 모두 건축 가능 구역(우선 구역 기준)이어야 한다('outside-zone' 은 조용한 건너뛰기) */
export function checkLot(ctx: PlaceCtx, lot: Lot, needBuildable: boolean, selfRoad = lot.ri): {code: string; msg: string} | null {
  const pts = lotSamples(lot);
  if (needBuildable && !lotSamples(lot, 0, true).every(p => ctx.buildableAt(p[0], p[1]))) return {code: 'outside-zone', msg: ''};
  if (!pts.every(p => ctx.inBounds(p[0], p[1]))) return {code: 'outside-bounds', msg: '대지가 도시 경계(bounds) 밖으로 나간다'};
  const capped = sightAxesOf(ctx.src, ctx.opts.sightAxes).length > 0 && !ctx.opts.sightNoBuild;
  for (const e of ctx.src.exceptions) {
    if (e.kind !== 'noBuild') continue;
    // 시선 축 회랑(nb-sight*)은 건물 높이 상한(sightCap)으로 대체: 통째로 금지하지 않는다
    if (capped && /^nb-sight/.test(e.id)) continue;
    const hit = pts.some(p => pointInPolygon(p[0], p[1], e.poly)) || e.poly.some(q => Math.abs((q[0] - lot.cx) * lot.ux + (q[1] - lot.cz) * lot.uz) < lot.w / 2 && Math.abs((q[0] - lot.cx) * lot.vx + (q[1] - lot.cz) * lot.vz) < lot.d / 2);
    if (hit) return {code: 'no-build', msg: `건축 금지 구역 ${e.id}${e.reason ? ' (' + e.reason + ')' : ''}와 겹친다`};
  }
  for (const p of pts) {
    if (ctx.inJunctionLot(p[0], p[1]) >= 0) return {code: 'junction-reserve', msg: '교차로 금지 구역 안'};
    for (const h of ctx.hits(p[0], p[1], 0.2)) if (h.dist < h.e5 + (h.ri === selfRoad ? 0.05 : 0.3)) return {code: 'road-overlap', msg: `도로 ${ctx.roads[h.ri].id} 의 포장·보도 위에 걸친다`};
  }
  const o = lotObb(lot);
  for (const ob of ctx.obstacles(lot.cx, lot.cz, Math.hypot(lot.w, lot.d) / 2 + 1, -1e9, 1e9, ['lot', 'building'])) {
    if (ob.owner === lot.id) continue;
    if (ob.obb ? obbOverlap(o, ob.obb) : false) return {code: 'lot-overlap', msg: `${ob.owner} 와 겹친다`};
  }
  return null;
}

/** 명시 ParcelSource → Lot (구역은 parcel.zone, 없으면 중심을 포함하는 첫 구역, 양식은 구역 양식 또는 house) */
export function lotFromParcel(ctx: PlaceCtx, p: ParcelSource, style: BuildingStyle): {lot?: Lot; rej?: LotRej} {
  const ri = ctx.byId.get(p.road);
  if (ri === undefined) return {rej: {owner: p.id, code: 'road-missing', msg: `필지의 도로 ${p.road} 가 없거나 거부되었다`}};
  const f = lotFrame(ctx, ri, p.side, p.t0, Math.min(p.t1, ctx.roads[ri].length), p.depth);
  if (!f) return {rej: {owner: p.id, code: 'zero-length', msg: '필지 전면이 너무 짧다'}};
  const lot: Lot = {id: p.id, zone: p.zone ?? '', road: p.road, ri, side: p.side, t0: p.t0, t1: p.t1, depth: p.depth, cx: f.cx, cz: f.cz, ux: f.ux, uz: f.uz, vx: f.vx, vz: f.vz, w: f.w, d: p.depth, lat0: f.lat0, style, explicit: true, sMid: f.sMid};
  const bad = checkLot(ctx, lot, false);
  return bad ? {rej: {owner: p.id, code: bad.code, msg: bad.msg}} : {lot};
}

/** 건물 발자국 대지 판정(경사·고도). 반환 null 이면 통과 */
export function siteCheck(ctx: PlaceCtx, o: Obb): {code: 'slope' | 'altitude'; msg: string; y: number} | {code: null; y: number} {
  const maxS = ctx.opts.maxSlope ?? 0.12, maxA = ctx.opts.maxAlt ?? 40;
  const rep = siteReport(ctx.terrain, o.cx, o.cz, o.hw * 2, o.hd * 2, o.rot, maxS, maxA);
  if (!rep.okAlt) return {code: 'altitude', msg: `발자국 최고 고도 ${rep.maxH.toFixed(1)}m 가 건축 상한 ${maxA}m 를 넘는다`, y: rep.centerH};
  if (!rep.okSlope) return {code: 'slope', msg: `대지 경사 ${(rep.planeSlope * 100).toFixed(1)}% (국지 최대 ${(rep.maxSlope * 100).toFixed(1)}%) 가 한도 ${(maxS * 100).toFixed(0)}% 를 넘는다`, y: rep.centerH};
  return {code: null, y: rep.centerH};
}

// ───────── 대지 평탄화 ─────────
export const PAD_SLOPE = 0.5;
export const PAD_MARGIN = 4.0;
/** 발자국 박스를 margin 만큼 키운 평지 + 바깥은 경사 PAD_SLOPE 포락선(깎기·쌓기). 도로 구역(road 비트 1)은 건드리지 않는다. clamp 이라 멱등 */
export function makePad(id: string, o: Obb, y: number): PadRec {
  return {id, cx: o.cx, cz: o.cz, hw: o.hw + PAD_MARGIN, hd: o.hd + PAD_MARGIN, rot: o.rot, y: Math.round(y * 20) / 20};
}
/** 패드들을 id 순서로 적용(결정적). 영향 칸 수를 돌려준다 */
export function applyPads(t: Terrain, pads: PadRec[]): number {
  let n = 0;
  const list = pads.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of list) {
    const R = Math.min(30, 6 / PAD_SLOPE), bb = aabbOf(p), x0 = bb[0] - R, z0 = bb[1] - R, x1 = bb[2] + R, z1 = bb[3] + R;
    const i0 = Math.max(0, Math.floor((x0 - t.x0) / t.cell)), i1 = Math.min(t.cols - 1, Math.ceil((x1 - t.x0) / t.cell));
    const j0 = Math.max(0, Math.floor((z0 - t.z0) / t.cell)), j1 = Math.min(t.rows - 1, Math.ceil((z1 - t.z0) / t.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const idx = j * t.cols + i;
      if (t.road[idx] & 1) continue;
      const [lx, lz] = toLocal(p, t.x0 + i * t.cell, t.z0 + j * t.cell), dd = Math.hypot(Math.max(Math.abs(lx) - p.hw, 0), Math.max(Math.abs(lz) - p.hd, 0));
      if (dd <= 0) { t.h[idx] = p.y; t.road[idx] |= 2; n++; }
      else if (dd < R) { const env = dd * PAD_SLOPE, h = t.h[idx], c = Math.min(Math.max(h, p.y - env), p.y + env); if (c !== h) { t.h[idx] = c; n++; } }
    }
  }
  return n;
}
export { distPointSeg, corners };
