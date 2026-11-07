// 블록 안쪽 채움(infill): 도로변 줄(앞줄+뒷줄 3줄)이 못 닿은 깊은 블록 속을 채운다.
// 구역이 소유한 땅(우선 구역 래스터)의 5m 격자 후보를 "가장 가까운 보도 도로까지의 거리" 순으로 보고, 그 도로 접선에 맞춘 정렬 필지(row 5)를 놓는다.
// 필지는 같은 장애물 규칙(checkLot)을 지나므로 도로·교차로·다른 필지·건물을 침범하지 않고, 건물이 서는 단계(planLot)·문→보도 경로 검증(place.ts 뒷줄 규칙)도 그대로 탄다.
import type {BuildingStyle, ZoneSource} from '../city-schema.js';
import type {PlaceCtx} from './place-ctx.js';
import type {Lot} from './place-types.js';
import {checkLot, siteCheck} from './parcels.js';
import type {LotRej} from './parcels.js';
import {pointAt} from './roads.js';

/** 양식별 채움 필지 크기 [전면 폭, 깊이] (m). 공공·랜드마크는 채우지 않는다 */
export const INFILL_SIZE: Partial<Record<BuildingStyle, [number, number]>> = {house: [16, 18], lodge: [26, 24], shop: [14, 18], office: [28, 30], apartment: [44, 34], highrise: [44, 42], barn: [36, 30]};
/** 보도까지 걸어갈 최대 거리(m) */
const MAX_WALK = 80, STEP = 5;
export const INFILL_ROW = 5;

export function infillLots(ctx: PlaceCtx, zone: ZoneSource, zi: number, style: BuildingStyle, out: {lots: Lot[]; rej: LotRej[]; tried: number}, reg: (l: Lot) => void): void {
  const size = INFILL_SIZE[style];
  if (!size || zone.use === 'farm') return;
  const [w, d] = size;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of zone.poly) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  interface Cand { x: number; z: number; ri: number; s: number; lat: number; dist: number; e5: number }
  const cands: Cand[] = [];
  for (let z = Math.ceil(z0 / STEP) * STEP; z <= z1; z += STEP) for (let x = Math.ceil(x0 / STEP) * STEP; x <= x1; x += STEP) {
    const dbg = (k: string) => (globalThis as any).__ifb?.(zone.id, k);
    if (ctx.zoneAt(x, z) !== zi) { dbg('c-notzone'); continue; }
    if (!ctx.inBounds(x, z)) { dbg('c-bounds'); continue; }
    if (ctx.obstacles(x, z, 0.5, -1e9, 1e9, ['lot', 'building']).length) { dbg('c-lot'); continue; }
    let best: Cand | null = null;
    for (const h of ctx.hits(x, z, MAX_WALK)) {
      if (h.layer !== 0 || h.e4 - h.e3 < 1.0 || ctx.roads[h.ri].cls === 'expressway') continue;
      const g = h.dist - h.e5;
      if (g < 0 || g > MAX_WALK || (best && g >= best.dist - best.e5)) continue;
      best = {x, z, ri: h.ri, s: h.s, lat: h.lat, dist: h.dist, e5: h.e5};
    }
    if (!best) dbg('c-noroad'); else if (best.dist - best.e5 < d / 2) dbg('c-tooclose'); else cands.push(best);
  }
  (globalThis as any).__if?.(zone.id, cands.length);
  cands.sort((a, b) => (a.dist - a.e5) - (b.dist - b.e5) || a.x - b.x || a.z - b.z);
  for (const c of cands) {
    if (ctx.obstacles(c.x, c.z, 0.5, -1e9, 1e9, ['lot', 'building']).length) continue;
    const r = ctx.roads[c.ri], p = pointAt(r, c.s), sgn = c.lat >= 0 ? 1 : -1;
    // v = 도로에서 멀어지는 방향(접선의 법선), u = 접선
    const ux = p.tx, uz = p.tz, vx = -p.tz * sgn, vz = p.tx * sgn;
    const lot: Lot = {id: `p-${zone.id}-in-${Math.round(c.x)}-${Math.round(c.z)}`, zone: zone.id, road: r.id, ri: c.ri, side: sgn > 0 ? 'right' : 'left', t0: c.s - w / 2, t1: c.s + w / 2, depth: d, cx: c.x, cz: c.z, ux, uz, vx, vz, w, d, lat0: c.dist - d / 2, style, explicit: false, sMid: c.s, row: INFILL_ROW};
    const bad = checkLot(ctx, lot, true, -1);
    (globalThis as any).__ifb?.(zone.id, bad ? bad.code : 'ok');
    if (bad) continue;
    // 건물이 설 수 있는 대지(경사·고도)만 필지로 만든다: 안 서는 후보까지 거부 목록에 쌓지 않는다
    const sc = siteCheck(ctx, {cx: c.x, cz: c.z, hw: Math.min(w, 24) / 2 - 2, hd: d / 2 - 3, rot: Math.atan2(-uz, ux) * 180 / Math.PI});
    if (sc.code) continue;
    out.tried++;
    out.lots.push(lot); reg(lot);
  }
}
