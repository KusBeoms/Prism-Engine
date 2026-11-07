// 필지 → 건물 자동 채움. 양식·치수·층수는 구역 용도/밀도와 (seed, 구역, 필지 id) 하위 시드로 정해져 한 구역을 다시 만들어도 다른 구역은 변하지 않는다.
// 건물 id = `b-<필지id>` (아파트 단지는 `-a`,`-b` 접미). 문은 도로를 향한 변(facing 's' = 로컬 +z)에 낸다. 모든 치수는 SCALE.md(층고·문·최소 실내) 기준.
import type {BuildingSource, BuildingStyle, ExceptionSource, ZoneSource} from '../city-schema.js';
import {DEFAULTS, SCALE} from '../city-schema.js';
import type {Obb} from './obb.js';
import {corners} from './obb.js';
import type {PlaceCtx} from './place-ctx.js';
import {FALLBACK, ROOFS, STYLE_CFG, TALL_WALLS, WALLS, densityOf, fitSetback, fitSide} from './place-cfg.js';
import type {Lot, PadRec, PlacedBuilding, SightAxis} from './place-types.js';
import {makePad, siteCheck} from './parcels.js';
import type {LotRej} from './parcels.js';
import {sightBlock, sightCap} from './sight.js';
import {CORRIDOR_W} from './lotpack.js';
import {rngFor} from './rng.js';
import type {Rng} from './rng.js';

const RAD = Math.PI / 180;
const ROOF_EXTRA = 1.5;
const r2 = (v: number): number => Math.round(v * 100) / 100;
export interface LotPlan {
  lot: Lot; zone: string;
  buildings: PlacedBuilding[]; pads: PadRec[];
  /** 대지 안 주차 계획(깊이는 앞 경계에서 건물 앞면까지 쓸 수 있는 거리) */
  park: {kind: 'lot' | 'forecourt' | null; depth: number};
  vacant: boolean; rej?: LotRej;
}
const PARK_P: Partial<Record<BuildingStyle, number>> = {shop: 0.35, office: 0.5, barn: 0.4};
const PURPOSE: Record<BuildingStyle, string> = {house: 'residence', shop: 'retail', apartment: 'apartment-complex', office: 'office', highrise: 'office-tower', civic: 'civic', barn: 'warehouse', lodge: 'lodge', landmark: 'landmark'};
/** 건물 박스의 rot: 로컬 +z 가 도로 쪽(-v) 을 향한다 → (sinθ, cosθ) = (-vx, -vz) */
export const facingRot = (l: {vx: number; vz: number}): number => Math.atan2(-l.vx, -l.vz) / RAD;

function pickFloors(rng: Rng, cfg: (typeof STYLE_CFG)[BuildingStyle]): number {
  return rng.weighted(cfg.floors, cfg.fw);
}
function door(rng: Rng, style: BuildingStyle, w: number): {x: number; z: number; w: number; h: number; facing: 's'} {
  const cfg = STYLE_CFG[style], off = style === 'house' || style === 'lodge' || style === 'shop' ? rng.range(-Math.min(w / 4, 2.5), Math.min(w / 4, 2.5)) : 0;
  return {x: r2(off), z: 0, w: cfg.door.w, h: cfg.door.h, facing: 's'};
}

/** 건물 하나의 원본을 만든다(문 z 는 호출자가 d/2 로 채움). obb 는 발자국 박스 */
function makeBuilding(id: string, lot: Lot, zone: string, style: BuildingStyle, rng: Rng, o: Obb, floors: number, y: number): BuildingSource {
  const cfg = STYLE_CFG[style], d = door(rng, style, o.hw * 2);
  d.z = r2(o.hd);
  const tall = style === 'highrise' || style === 'office' || style === 'apartment';
  return {
    id, parcel: lot.id, x: r2(o.cx), z: r2(o.cz), w: r2(o.hw * 2), d: r2(o.hd * 2), rot: r2(o.rot), floors, style,
    wall: rng.pick(tall ? TALL_WALLS : WALLS), roof: rng.pick(ROOFS), purpose: PURPOSE[style],
    interior: {mode: 'onsite', door: d, floors, floorH: cfg.floorH, floorY: r2(y), wallThick: SCALE.wallThick, slab: SCALE.floorSlab, plan: `${style}-${Math.min(3, Math.max(1, Math.round(o.hw * 2 * o.hd * 2 / cfg.minInterior)))}`},
    groundY: r2(y),
  };
}

/** 필지 하나의 건물 계획. 건물이 서지 않는 필지(밀도)는 vacant, 대지 조건에 걸리면 rej */
/** 대지가 너무 작을 때 한 단계 작은 양식으로 내려 본다(고층 → 사무 → 상가, 아파트 → 주택, 공공 → 사무) */
export function planLot(ctx: PlaceCtx, lot: Lot, zone: ZoneSource, axes: SightAxis[], styleOver?: Map<string, BuildingStyle>, down = false): LotPlan {
  const rng = rngFor(ctx.src.seed, zone.id, lot.id);
  let style = lot.style;
  if (!down && zone.use === 'farm' && !zone.style) style = rng.chance(0.4) ? 'barn' : 'lodge';
  const forced = down ? undefined : styleOver?.get(`b-${lot.id}`) ?? styleOver?.get(`b-${lot.id}-a`);
  if (forced) style = forced;
  const cfg = STYLE_CFG[style], plan: LotPlan = {lot, zone: zone.id, buildings: [], pads: [], park: {kind: null, depth: 0}, vacant: false};
  const dens = lot.explicit ? 1 : densityOf(zone) * ((lot.row ?? 0) >= 1 ? 0.9 : 1);
  if (!rng.chance(dens)) { plan.vacant = true; return plan; }
  const side = fitSide(style, lot.w), fs = fitSetback(style, lot.d), rear = fs.rear;
  // 앞 주차(12m)를 두고도 건물 깊이 8m 가 남을 때만 주차를 둔다
  const parkWant = (lot.row ?? 0) === 0 && lot.d - Math.max(fs.front, 12) - rear >= 8 && (cfg.park === 'lot' || (cfg.park === 'forecourt' && rng.chance(PARK_P[style] ?? 0.4)));
  const front = parkWant ? Math.max(fs.front, 12) : fs.front;
  const maxD = lot.d - front - rear, n = style === 'apartment' && lot.w >= 56 ? 2 : 1;
  const toward = (lot.row ?? 0) >= 1 && lot.rowLast !== false, cor = lot.corridor !== undefined && !toward ? lot.corridor : 0;
  const wCap = Math.min((lot.w - 2 * side - (n - 1) * 6) / n, cor ? lot.w - side - CORRIDOR_W : Infinity);
  let w = Math.min(rng.range(cfg.w[0], cfg.w[1]), wCap), d = Math.min(rng.range(cfg.d[0], cfg.d[1]), maxD);
  // 실내가 성립하는 최소 면적: 작으면 키운다(한도 안에서)
  const area = (ww: number, dd: number) => (ww - 2 * SCALE.wallThick) * (dd - 2 * SCALE.wallThick);
  if (area(w, d) < cfg.minInterior) { w = Math.min(wCap, w * 1.25); d = Math.min(maxD, d * 1.25); }
  if (w < Math.min(cfg.w[0], 7) - 0.01 || d < 5.9 || area(w, d) < cfg.minInterior * 0.8) {
    const fb = FALLBACK[style];
    if (fb && !forced && !lot.explicit) return planLot(ctx, {...lot, style: fb}, zone, axes, styleOver, true);
    plan.rej = {owner: lot.id, code: 'too-small', msg: `대지(${lot.w.toFixed(0)}×${lot.d.toFixed(0)})가 ${style} 의 최소 실내 면적(${cfg.minInterior}㎡)을 못 채운다`}; return plan; }
  plan.park = {kind: parkWant ? (cfg.park === 'lot' ? 'lot' : 'forecourt') : null, depth: front};
  const rot = facingRot(lot), floors0 = pickFloors(rng, cfg);
  for (let k = 0; k < n; k++) {
    const slotW = lot.w / n, aMax = Math.max(0, slotW / 2 - w / 2 - side);
    let a = (n === 2 ? (k === 0 ? -1 : 1) * slotW / 2 : 0) + (rng.range(-1, 1) * Math.min(aMax, lot.w * 0.15)) * (n === 2 ? 0.3 : 1);
    // 통로 쪽: 앞줄 건물은 통로 반대쪽 끝으로 붙이고, 뒷줄 건물은 통로 쪽으로 붙인다
    if (lot.corridor !== undefined && n === 1) a = (toward ? 1 : -1) * lot.corridor * Math.max(0, lot.w / 2 - side - w / 2);
    // 아파트는 단지 뒤쪽(앞은 주차·정원), 나머지는 앞면 setback 위치
    const bFront = style === 'apartment' ? lot.d - rear - d : front + (rng.chance(0.3) ? Math.min(2, Math.max(0, maxD - d)) : 0);
    // 경사·고도에 걸리면 대지 안에서 위치(옆·뒤로)와 크기(×0.85, ×0.72)를 바꿔 다시 본다
    const fixedA = lot.corridor !== undefined && n === 1, aMax2 = Math.max(0, slotW / 2 - w / 2 - side);
    let o: Obb = {cx: 0, cz: 0, hw: 0, hd: 0, rot}, sc: ReturnType<typeof siteCheck> = {code: null, y: 0};
    const SHIFT: [number, number, number][] = [];
    for (const k2 of [1, 0.85, 0.72]) for (const sb of [0, 0.5, 1]) for (const sa of [0, 1, -1]) SHIFT.push([k2, sa, sb]);
    for (const [k2, sa, sb] of SHIFT) {
      if (fixedA && sa !== 0) continue;
      const ww = w * k2, dd = d * k2;
      if (ww < Math.min(cfg.w[0], 7) - 0.01 || dd < 5.9) continue;
      const aa = a + sa * Math.max(0, aMax2 + (w - ww) / 2) * 0.9, bb = style === 'apartment' ? bFront + (d - dd) : bFront + sb * Math.max(0, maxD - dd);
      const c2 = bb + dd / 2;
      o = {cx: lot.cx + lot.ux * aa + lot.vx * (-lot.d / 2 + c2), cz: lot.cz + lot.uz * aa + lot.vz * (-lot.d / 2 + c2), hw: ww / 2, hd: dd / 2, rot};
      sc = siteCheck(ctx, o);
      if (!sc.code) break;
    }
    if (sc.code) { plan.rej = {owner: lot.id, code: sc.code, msg: sc.msg}; plan.buildings = []; plan.pads = []; return plan; }
    let floors = floors0;
    const topOf = (f: number) => sc.y + f * cfg.floorH + ROOF_EXTRA;
    // 시선 축 높이 상한: 쐐기 안의 건물은 낮게 짓는다. 1층도 6m 를 못 넘으면 회랑으로 보고 금지
    const cap = sightCap(ctx, axes, o);
    if (cap - sc.y < 6) { plan.rej = {owner: lot.id, code: 'no-build', msg: `시선 축 회랑: 높이 상한이 지면 위 ${Math.max(0, cap - sc.y).toFixed(1)}m 로 6m 미만`}; plan.buildings = []; plan.pads = []; return plan; }
    while (floors > 1 && topOf(floors) > cap) floors--;
    const hit = sightBlock(ctx, axes, o, topOf(floors));
    if (hit) { plan.rej = {owner: lot.id, code: 'sight-axis', msg: `1층도 시선 축 ${hit} 을 가린다`}; plan.buildings = []; plan.pads = []; return plan; }
    const id = n === 2 ? `b-${lot.id}-${k === 0 ? 'a' : 'b'}` : `b-${lot.id}`;
    const src = makeBuilding(id, lot, zone.id, style, rng, o, floors, sc.y);
    plan.buildings.push({src, obb: o, top: topOf(floors), lot: lot.id, zone: zone.id});
    plan.pads.push(makePad(`pad-${id}`, o, sc.y));
  }
  return plan;
}

/** 명시 건물(source.buildings)을 PlacedBuilding 으로(자동 건물과 같은 형식). 대지 높이는 groundY 또는 부지 보고의 중심 높이 */
export function explicitBuilding(ctx: PlaceCtx, b: BuildingSource, zone: string): {pb: PlacedBuilding; pad: PadRec; warn?: string} {
  const o: Obb = {cx: b.x, cz: b.z, hw: b.w / 2, hd: b.d / 2, rot: b.rot}, sc = siteCheck(ctx, o);
  const y = b.groundY ?? sc.y, cfg = STYLE_CFG[b.style];
  const src: BuildingSource = {...b, interior: {...b.interior, floorY: b.interior.floorY ?? y}, groundY: b.groundY ?? y};
  return {pb: {src, obb: o, top: y + b.floors * (b.interior.floorH || cfg.floorH) + ROOF_EXTRA, lot: b.parcel ?? '', zone}, pad: makePad(`pad-${b.id}`, o, y), warn: sc.code ? `${b.id}: ${sc.msg}` : undefined};
}

/** 예외 적용: style → 양식/층고 교체, fixed → 위치·회전 고정(대지 조건은 다시 보고만). 명시·자동 건물 모두 */
export function applyExceptions(ctx: PlaceCtx, list: PlacedBuilding[], ex: ExceptionSource[], out: LotRej[]): void {
  for (const e of ex) {
    if (e.kind === 'noBuild') continue;
    const pb = list.find(p => p.src.id === e.target);
    if (!pb) continue;
    if (e.kind === 'style') {
      const cfg = STYLE_CFG[e.style];
      pb.src = {...pb.src, style: e.style, interior: {...pb.src.interior, floorH: cfg.floorH}};
    } else {
      const rot = e.rot ?? pb.src.rot, o: Obb = {...pb.obb, cx: e.x, cz: e.z, rot}, sc = siteCheck(ctx, o);
      if (sc.code) { out.push({owner: pb.src.id, code: 'fixed-site', msg: `고정 위치가 대지 조건을 어긴다: ${sc.msg}`}); }
      pb.src = {...pb.src, x: r2(e.x), z: r2(e.z), rot: r2(rot)};
      pb.obb = o;
    }
  }
}
export const footprintCorners = (b: PlacedBuilding) => corners(b.obb);
export { DEFAULTS };
