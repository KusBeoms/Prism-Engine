// 배치 단계 오케스트레이터: 명시 건물 → 구역별(필지·건물·대지 주차) → 도로변 주차 → 소품 → 녹지. 결과는 PlaceModel 로 보존해 구역 재빌드가 재사용한다.
// 순서가 곧 우선순위다: 건물·주차 점유가 먼저 등록되고 소품·나무는 그 위에서 피해 간다.
import type {ZoneSource} from '../city-schema.js';
import type {ParkingSlotOut, Placement} from '../city-compiled.js';
import {toWorld, axesOf} from './obb.js';
import type {PlaceCtx} from './place-ctx.js';
import {STYLE_CFG, zoneStyle} from './place-cfg.js';
import type {Interval, Lot, PadRec, PlacedBuilding, PropRec, PropRej, SightAxis} from './place-types.js';
import {lotFromParcel, makePad} from './parcels.js';
import {genLots} from './lotpack.js';
import type {LotPhase} from './lotpack.js';
import {doorTarget, routeAround} from './route.js';
import type {LotRej} from './parcels.js';
import {applyExceptions, explicitBuilding, planLot} from './buildings.js';
import type {LotPlan} from './buildings.js';
import {anchorParking, lotParking, streetParking} from './parking.js';
import {placeProps} from './props.js';
import type {DoorIv} from './props.js';
import {DEFAULT_PROPS} from './props-profiles.js';
import type {PropRule} from './props-profiles.js';
import {edgeForest, greenZones} from './green.js';
import type {GreenReport} from './green.js';
import type {DoorRef} from './graph.js';

export interface ZoneRes { zone: ZoneSource; lots: Lot[]; plans: LotPlan[]; rej: LotRej[]; tried: number; slots: ParkingSlotOut[]; drives: {ri: number; iv: Interval}[]; pads: PadRec[]; buildings: PlacedBuilding[] }
export interface PlaceModel {
  zones: Map<string, ZoneRes>;
  explicit: {buildings: PlacedBuilding[]; pads: PadRec[]; warns: string[]; rej: LotRej[]};
  streetPark: Map<number, ParkingSlotOut[]>;
  anchorPark: ParkingSlotOut[];
  props: PropRec[]; propRej: PropRej[];
  trees: Map<string, Placement[]>; green: Map<string, GreenReport>; edge: Placement[];
  doors: DoorRef[];
}
export const FREE_ZONE = '~free';
/** 같은 구역의 두 단계 결과를 합친다 */
const mergeRes = (a: ZoneRes, b: ZoneRes): ZoneRes => ({zone: a.zone, lots: [...a.lots, ...b.lots], plans: [...a.plans, ...b.plans], rej: [...a.rej, ...b.rej], tried: a.tried + b.tried, slots: [...a.slots, ...b.slots], drives: [...a.drives, ...b.drives], pads: [...a.pads, ...b.pads], buildings: [...a.buildings, ...b.buildings]});
const EMPTY = (zone: ZoneSource): ZoneRes => ({zone, lots: [], plans: [], rej: [], tried: 0, slots: [], drives: [], pads: [], buildings: []});

/** 건물을 장애물로 등록 + 문 앞 접근로(보도까지) 원을 등록해 나무·벤치가 길을 막지 않게 한다 */
export function registerBuilding(ctx: PlaceCtx, b: PlacedBuilding): void {
  const gy = b.src.groundY ?? 0;
  ctx.addObstacle({owner: b.src.id, kind: 'building', obb: b.obb, y0: gy - 2, y1: b.top});
  const d = b.src.interior.door, f = doorOut(b, 0);
  const nx = f.nx, nz = f.nz;
  for (let k = 0; k < 10; k++) {
    const x = f.x + nx * 2 * k, z = f.z + nz * 2 * k;
    if (ctx.hits(x, z, 0).some(h => h.dist < h.e5 + 2.5)) break;
    ctx.addObstacle({owner: `acc-${b.src.id}`, kind: 'prop', cx: x, cz: z, r: Math.max(1.0, d.w / 2 + 0.3), y0: gy - 1, y1: gy + 4});
  }
}
/** 뒷줄·채움 건물의 문→보도 경로를 2m 간격 접근로 원으로 등록해 나무·벤치가 길을 막지 않게 한다 */
function reserveRoute(ctx: PlaceCtx, b: PlacedBuilding, path: [number, number][]): void {
  const gy = b.src.groundY ?? 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 2));
    for (let k = 0; k < n; k++) ctx.addObstacle({owner: `acc-${b.src.id}`, kind: 'prop', cx: ax + (bx - ax) * k / n, cz: az + (bz - az) * k / n, r: 1.0, y0: gy - 1, y1: gy + 4});
  }
}
/** 문 바깥 점(문에서 out m)과 바깥 방향 단위벡터(월드) */
export function doorOut(b: PlacedBuilding, out: number): {x: number; z: number; nx: number; nz: number} {
  const d = b.src.interior.door, {ax, az} = axesOf(b.obb.rot), v: [number, number] = d.facing === 's' ? az : d.facing === 'n' ? [-az[0], -az[1]] : d.facing === 'e' ? ax : [-ax[0], -ax[1]];
  const p = toWorld(b.obb, d.x, d.z);
  return {x: p[0] + v[0] * out, z: p[1] + v[1] * out, nx: v[0], nz: v[1]};
}

export function runZone(ctx: PlaceCtx, zone: ZoneSource, axes: SightAxis[], styleOver: Map<string, import('../city-schema.js').BuildingStyle>, auto = true, phase: LotPhase = 'all', prev?: ZoneRes): ZoneRes {
  const res = EMPTY(zone), style = zone.id === FREE_ZONE ? 'house' : zoneStyle(zone);
  if (!style) return res;
  if (auto) { const gl = genLots(ctx, zone, style, phase, prev?.lots); res.lots.push(...gl.lots); res.rej.push(...gl.rej); res.tried = gl.tried; }
  for (const p of phase === 'back' || phase === 'infill' ? [] : ctx.src.parcels) {
    if ((p.zone ?? FREE_ZONE) !== zone.id && !(zone.id === FREE_ZONE && !ctx.src.zones.some(z => z.id === p.zone))) continue;
    const r = lotFromParcel(ctx, p, style);
    if (r.rej) { res.rej.push(r.rej); continue; }
    res.lots.push(r.lot!);
    ctx.addObstacle({owner: r.lot!.id, kind: 'lot', obb: {cx: r.lot!.cx, cz: r.lot!.cz, hw: r.lot!.w / 2 - 0.05, hd: r.lot!.d / 2 - 0.05, rot: Math.atan2(-r.lot!.uz, r.lot!.ux) * 180 / Math.PI}, y0: -1e9, y1: 1e9});
  }
  const hasB = new Set(ctx.src.buildings.map(b => b.parcel).filter(Boolean) as string[]);
  for (const lot of res.lots) {
    if (hasB.has(lot.id)) continue;
    const pl = planLot(ctx, lot, zone, axes, styleOver);
    if (pl.rej) res.rej.push(pl.rej);
    res.plans.push(pl);
  }
  const all = res.plans.flatMap(p => p.buildings);
  applyExceptions(ctx, all, ctx.src.exceptions, res.rej);
  // 앞줄 먼저 등록한 뒤 뒷줄 건물은 문→보도 경로가 있을 때만 남긴다(통로로 못 나오면 포기)
  const backLots = new Set(res.lots.filter(l => (l.row ?? 0) >= 1).map(l => l.id)), isBack = (b: PlacedBuilding) => backLots.has(b.lot), rowOf = new Map(res.lots.map(l => [l.id, l.row ?? 0]));
  for (const b of all) if (!isBack(b)) registerBuilding(ctx, b);
  // 뒷줄은 줄 순서(1,2,3)대로: 앞 줄 건물이 등록된 뒤에 문→보도 경로를 확인한다
  for (const b of all.filter(isBack).sort((x, y) => rowOf.get(x.lot)! - rowOf.get(y.lot)!)) {
    registerBuilding(ctx, b);
    const o = doorOut(b, 0.8), t = doorTarget(ctx, o.x, o.z);
    const rt = t ? routeAround(ctx, [o.x, o.z], [t.x, t.z], b.obb) : null;
    if (t && rt !== null) { reserveRoute(ctx, b, [[o.x, o.z], ...rt, [t.x, t.z]]); continue; }
    ctx.removeOwner(b.src.id); ctx.removeOwner(`acc-${b.src.id}`);
    res.rej.push({owner: b.lot, code: 'no-access', msg: '뒷줄 건물의 문에서 보도까지 갈 길이 없다'});
    b.lot = '';
  }
  const kept = all.filter(b => b.lot !== '');
  for (const pl of res.plans) pl.buildings = pl.buildings.filter(b => b.lot !== '');
  for (const b of kept) res.pads.push(makePad(`pad-${b.src.id}`, b.obb, b.src.groundY ?? 0));
  res.buildings = kept;
  for (const pl of res.plans) { const pk = lotParking(ctx, pl); res.slots.push(...pk.slots); if (pk.drive) res.drives.push({ri: pl.lot.ri, iv: pk.drive}); }
  return res;
}

/** 모든 건물의 문 → (도로, 쪽, s) 참조. 가장 가까운 도로 가장자리를 찾는다 */
export function doorRefs(ctx: PlaceCtx, list: PlacedBuilding[], rej: LotRej[]): DoorRef[] {
  const out: DoorRef[] = [];
  for (const b of list) {
    const o = doorOut(b, 0.8);
    const t = doorTarget(ctx, o.x, o.z);
    if (!t) { rej.push({owner: b.src.id, code: 'door-no-road', msg: '문 근처(90m)에 도로가 없다'}); continue; }
    out.push({id: b.src.id, x: o.x, z: o.z, ri: t.ri, side: t.side, s: t.s, own: b.obb});
  }
  return out;
}
export function rulesOf(ctx: PlaceCtx): PropRule[] {
  const src = ctx.src;
  let rules: PropRule[] = src.props.length ? src.props.map(p => ({...p})) : ctx.opts.defaultProps === false ? [] : DEFAULT_PROPS.map(p => ({...p}));
  const street = src.greenery.filter(g => g.kind === 'streetTree' && g.roadClass);
  if (street.length) rules = rules.filter(r => !(r.kind === 'tree' && street.some(g => g.roadClass === r.roadClass)));
  for (const g of street) rules.push({id: `green.${g.id}`, kind: 'tree', roadClass: g.roadClass!, side: 'both', spacing: g.spacing, offset: 0, clearance: g.clearance, band: 'plant', species: g.species});
  return rules;
}

export function placeAll(ctx: PlaceCtx, axes: SightAxis[]): PlaceModel {
  const src = ctx.src, styleOver = new Map<string, import('../city-schema.js').BuildingStyle>();
  for (const e of src.exceptions) if (e.kind === 'style') styleOver.set(e.target, e.style);
  const model: PlaceModel = {zones: new Map(), explicit: {buildings: [], pads: [], warns: [], rej: []}, streetPark: new Map(), anchorPark: [], props: [], propRej: [], trees: new Map(), green: new Map(), edge: [], doors: []};
  for (const b of src.buildings) { const e = explicitBuilding(ctx, b, ''); model.explicit.buildings.push(e.pb); if (e.warn) model.explicit.warns.push(e.warn); }
  applyExceptions(ctx, model.explicit.buildings, src.exceptions, model.explicit.rej);
  for (const b of model.explicit.buildings) { registerBuilding(ctx, b); model.explicit.pads.push(makePad(`pad-${b.src.id}`, b.obb, b.src.groundY ?? 0)); }
  // 단계별 필지: 모든 구역의 도로변 앞줄 → 뒷줄 → 블록 안쪽 채움(앞선 구역의 깊은 필지가 이웃 구역 도로변을 먹지 않게)
  for (const z of src.zones) model.zones.set(z.id, runZone(ctx, z, axes, styleOver, true, 'front'));
  for (const phase of ['back', 'infill'] as const) for (const z of src.zones) model.zones.set(z.id, mergeRes(model.zones.get(z.id)!, runZone(ctx, z, axes, styleOver, true, phase, model.zones.get(z.id))));
  const free: ZoneSource = {id: FREE_ZONE, use: 'residential', poly: []};
  if (src.parcels.some(p => !p.zone || !src.zones.some(z => z.id === p.zone))) model.zones.set(FREE_ZONE, runZone(ctx, free, axes, styleOver, false));
  finishStreet(ctx, model, axes);
  return model;
}

/** 도로변 주차 · 경기장 주차 · 소품 · 녹지 (구역 결과가 모인 뒤) */
export function finishStreet(ctx: PlaceCtx, model: PlaceModel, axes: SightAxis[], only?: {roads: Set<number>; sides?: undefined}, zonesOnly?: Set<string>): void {
  const allB = [...model.explicit.buildings, ...[...model.zones.values()].flatMap(z => z.buildings)];
  const drives = new Map<number, Interval[]>();
  for (const z of model.zones.values()) for (const d of z.drives) (drives.get(d.ri) ?? drives.set(d.ri, []).get(d.ri)!).push(d.iv);
  const roadsToDo = only ? only.roads : new Set(ctx.roads.map((_, i) => i));
  for (const ri of [...roadsToDo].sort((a, b) => a - b)) model.streetPark.set(ri, streetParking(ctx, ri, drives.get(ri) ?? []));
  if (!only) model.anchorPark = ctx.src.anchors.filter(a => a.kind === 'stadium').flatMap(a => anchorParking(ctx, a));
  const rej: LotRej[] = [];
  model.doors = doorRefs(ctx, allB, rej);
  model.explicit.rej.push(...rej);
  const doorIv: DoorIv[] = model.doors.map(d => { const b = allB.find(x => x.src.id === d.id)!; return {ri: d.ri, side: d.side, s: d.s, half: b.src.interior.door.w / 2}; });
  const keep = only ? model.props.filter(p => !only.roads.has(p.ri)) : [];
  for (const p of keep) ctx.addObstacle({owner: p.id, kind: 'prop', cx: p.x, cz: p.z, r: p.r, y0: p.y, y1: p.y + p.h});
  const pr = placeProps(ctx, {rules: rulesOf(ctx), doors: doorIv, drives, axes, only: only ? (ri => only.roads.has(ri)) : undefined});
  model.props = [...keep, ...pr.props];
  model.propRej = [...(only ? model.propRej.filter(r => !only.roads.has(ctx.byId.get(r.road) ?? -1)) : []), ...pr.rej];
  const g = greenZones(ctx, src(ctx), model.props.filter(p => p.kind === 'tree'), axes, zonesOnly);
  for (const z of src(ctx)) { if (!zonesOnly || zonesOnly.has(z.id)) { model.trees.delete(z.id); model.green.delete(z.id); } }
  for (const t of g.trees) { const id = t.owner.slice(5); (model.trees.get(id) ?? model.trees.set(id, []).get(id)!).push(t); }
  for (const r of g.report) model.green.set(r.zone, r);
  if (!only) { const budget = Math.max(0, (ctx.opts.maxTrees ?? 80000) - g.trees.length); model.edge = edgeForest(ctx, src(ctx), axes, budget); }
}
const src = (ctx: PlaceCtx): ZoneSource[] => ctx.src.zones;
export { STYLE_CFG };
