// 주차칸: 대지 안(단지·공공·상점 앞) 직각 주차 한 줄 + 도로변 주차대(별도 차선 띠) 평행 주차. 한 칸 = 실제 차량 한 대(vehicleId 가 있는 칸만 점유, 장식 차 없음).
// 칸 id 는 위치 격자(도로 s 6m 슬롯 번호 / 대지 안 번호)에서 파생돼 안정적이다. 주행 차로에는 칸을 만들지 않는다(주차대 e1~e2 띠만).
import {SCALE} from '../city-schema.js';
import type {AnchorSource} from '../city-schema.js';
import type {ParkingSlotOut} from '../city-compiled.js';
import {obbOverlap, corners} from './obb.js';
import type {Obb} from './obb.js';
import type {PlaceCtx} from './place-ctx.js';
import type {Interval, Lot} from './place-types.js';
import {SEC, pointAt, sideEdges} from './roads.js';
import {siteReport} from './terrain.js';
import {rngFor} from './rng.js';
import type {LotPlan} from './buildings.js';

const RAD = Math.PI / 180;
const r2 = (v: number): number => Math.round(v * 100) / 100;
export const BAY_LEN = SCALE.parking.parallel.d;
export const AISLE = 6.0;
export const STREET_CLEAR = 8;
export const DRIVEWAY_W = 6.5;
const SLOT_SLOPE = 0.1;

/** 칸 박스 하나가 놓일 수 있는가(도로·교차로·경계·건물·다른 칸·경사). 이유 문자열 또는 null */
export function slotBlocked(ctx: PlaceCtx, o: Obb, ignoreRoad = false): string | null {
  const pts = [...corners(o), [o.cx, o.cz] as [number, number]];
  for (const p of pts) {
    if (!ctx.inBounds(p[0], p[1])) return 'outside-bounds';
    if (ctx.inJunction(p[0], p[1]) >= 0) return 'junction';
    if (!ignoreRoad) for (const h of ctx.hits(p[0], p[1], 0.1)) if (h.dist < h.e5 + 0.1) return 'road';
  }
  for (const ob of ctx.obstacles(o.cx, o.cz, Math.max(o.hw, o.hd) + 0.5, -1e9, 1e9, ['building', 'parking'])) if (ob.obb && obbOverlap(o, ob.obb)) return 'overlap';
  const rep = siteReport(ctx.terrain, o.cx, o.cz, o.hw * 2, o.hd * 2, o.rot, SLOT_SLOPE, 1e9);
  return rep.okSlope ? null : 'slope';
}
const yaw = (dx: number, dz: number): number => Math.atan2(dx, dz) / RAD;

function mk(ctx: PlaceCtx, id: string, kind: ParkingSlotOut['kind'], o: Obb, forward: number, layer: number): ParkingSlotOut {
  const occ = rngFor(ctx.src.seed, 'veh', id).chance(ctx.opts.occupancy ?? 0.8);
  return {id, x: r2(o.cx), y: r2(ctx.groundY(o.cx, o.cz)), z: r2(o.cz), rot: r2(forward), kind, layer, ...(occ ? {vehicleId: `v-${id}`} : {})};
}

/** 대지 안 주차 한 줄(앞 경계에서 AISLE 만큼 안쪽부터 깊이 5.0): 칸 폭 2.5. 또한 진입로(driveway) 구간을 돌려준다 */
export function lotParking(ctx: PlaceCtx, plan: LotPlan): {slots: ParkingSlotOut[]; drive: Interval | null} {
  const lot = plan.lot, out: ParkingSlotOut[] = [];
  if (!plan.park.kind || !plan.buildings.length) return {slots: out, drive: null};
  const pw = SCALE.parking.perp.w, pd = SCALE.parking.perp.d;
  if (plan.park.depth < 0.5 + AISLE + pd + 0.3) return {slots: out, drive: null};
  const bC = 0.5 + AISLE + pd / 2, n = Math.floor((lot.w - 6) / pw), rotCar = yaw(lot.vx, lot.vz), rotOb = Math.atan2(-lot.uz, lot.ux) / RAD;
  const rng = rngFor(ctx.src.seed, 'pk', lot.id);
  for (let k = 0; k < n; k++) {
    const a = (k - (n - 1) / 2) * pw;
    const o: Obb = {cx: lot.cx + lot.ux * a + lot.vx * (-lot.d / 2 + bC), cz: lot.cz + lot.uz * a + lot.vz * (-lot.d / 2 + bC), hw: pw / 2, hd: pd / 2, rot: rotOb};
    if (slotBlocked(ctx, o)) continue;
    const id = `pl-${lot.id}-${k}`;
    out.push(mk(ctx, id, 'perpendicular', o, rotCar + (rng.chance(0.25) ? 180 : 0), 0));
    ctx.addObstacle({owner: id, kind: 'parking', obb: o, y0: -1e9, y1: 1e9});
  }
  return {slots: out, drive: {s0: lot.sMid - DRIVEWAY_W / 2 - 0.8, s1: lot.sMid + DRIVEWAY_W / 2 + 0.8, reason: 'driveway', side: lot.side}};
}

/** 도로변 주차대 평행 주차. 금지: 교차로 팔(+횡단보도 연장 +8m), 진입로, 예약 구간, 주차대가 좁은(<2.0) 곳, 비지상 구간 */
export function streetParking(ctx: PlaceCtx, ri: number, drives: Interval[]): ParkingSlotOut[] {
  const r = ctx.roads[ri], out: ParkingSlotOut[] = [];
  for (const side of ['left', 'right'] as const) {
    const right = side === 'right', forb: [number, number][] = [];
    for (const a of ctx.arms.get(ri) ?? []) forb.push([a.s0 - STREET_CLEAR, a.s1 + STREET_CLEAR]);
    for (const d of drives) if (d.side === side || d.side === 'both') forb.push([d.s0, d.s1]);
    for (const rs of ctx.opts.reserve ?? []) if (rs.road === r.id && (!rs.side || rs.side === 'both' || rs.side === side)) forb.push([rs.s0, rs.s1]);
    forb.sort((a, b) => a[0] - b[0]);
    for (let k = 0; (k + 1) * BAY_LEN <= r.length + 1e-6; k++) {
      const s0 = k * BAY_LEN, s1 = s0 + BAY_LEN, sm = (s0 + s1) / 2;
      if (forb.some(f => f[1] > s0 && f[0] < s1)) continue;
      let ok = true;
      for (const s of [s0, sm, s1]) {
        const p = pointAt(r, s), e = sideEdges(p.sec, 0, right), seg = r.segs[p.seg];
        if (p.sec[right ? SEC.parkR : SEC.parkL] < 2.0 || e.e2 - e.e1 < 2.0 || seg.kind !== 'ground' || seg.layer !== 0) { ok = false; break; }
      }
      if (!ok) continue;
      const p = pointAt(r, sm), e = sideEdges(p.sec, 0, right), lat = (e.e1 + e.e2) / 2, c = ctx.at(ri, sm, right ? lat : -lat);
      const fx = right ? p.tx : -p.tx, fz = right ? p.tz : -p.tz;
      const o: Obb = {cx: c.x, cz: c.z, hw: SCALE.parking.parallel.w / 2, hd: BAY_LEN / 2, rot: rotAlong(p.tx, p.tz)};
      // 주차대 박스의 로컬 z 가 도로 방향: hw=폭(가로), hd=길이(도로 방향)
      const id = `ps-${r.id}-${side[0]}-${k}`;
      if (slotBlocked(ctx, o, true)) continue;
      out.push(mk(ctx, id, 'parallel', o, yaw(fx, fz), 0));
      ctx.addObstacle({owner: id, kind: 'parking', obb: o, y0: -1e9, y1: 1e9});
    }
  }
  return out;
}
/** 로컬 +z 가 도로 방향 (tx,tz) 을 향하는 박스 rot: (sinθ, cosθ) = (tx, tz) */
const rotAlong = (tx: number, tz: number): number => Math.atan2(tx, tz) / RAD;

/** 경기장 앵커 주차장: 앵커의 정면(rot) 방향 앞에 직각 주차 격자(열 × 행), 칸마다 같은 검증. 칸 id 는 앵커 id 와 격자 번호 */
export function anchorParking(ctx: PlaceCtx, a: AnchorSource, cols = 20, rows = 4): ParkingSlotOut[] {
  const th = (a.rot ?? 0) * RAD, fx = Math.sin(th), fz = Math.cos(th), ux = Math.cos(th), uz = -Math.sin(th), out: ParkingSlotOut[] = [];
  const pw = SCALE.parking.perp.w, pd = SCALE.parking.perp.d, y0 = a.flattenRadius + 8;
  for (let rI = 0; rI < rows; rI++) for (let c = 0; c < cols; c++) {
    const aL = (c - (cols - 1) / 2) * pw, bL = y0 + rI * (pd + (rI % 2 ? 0 : AISLE)) + pd / 2;
    const o: Obb = {cx: a.x + ux * aL + fx * bL, cz: a.z + uz * aL + fz * bL, hw: pw / 2, hd: pd / 2, rot: a.rot ?? 0};
    if (slotBlocked(ctx, o)) continue;
    const id = `pa-${a.id}-${rI}-${c}`;
    out.push(mk(ctx, id, 'perpendicular', o, ((a.rot ?? 0) + (rI % 2 ? 180 : 0)), 0));
    ctx.addObstacle({owner: id, kind: 'parking', obb: o, y0: -1e9, y1: 1e9});
  }
  return out;
}
export type { Lot };
