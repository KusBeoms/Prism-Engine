// 배치 결과(PlaceModel)를 CityCompiled 로 조립: 대지 평탄화 적용·재인코딩, 건물/소품/나무 배치, 충돌체, 주차, 그래프, 거부 목록, 통계.
// 정렬은 id 문자열 순이라 같은 입력 → 같은 출력(결정적)이다.
import type {BuildingSource} from '../city-schema.js';
import type {CityCompiled, Collider, CompiledParcel, ParkingSlotOut, Placement} from '../city-compiled.js';
import {rnd} from './bytes.js';
import {buildingCollider, buildingPlacement, propCollider, propPlacement, treeCollider} from './colliders.js';
import {buildGraph} from './graph.js';
import type {GraphStats} from './graph.js';
import type {GreenReport} from './green.js';
import {applyPads} from './parcels.js';
import type {PlaceCtx} from './place-ctx.js';
import type {PlaceModel} from './place.js';
import type {PadRec, PlacedBuilding} from './place-types.js';
import {cloneTerrain, encodeTerrainCompiled, sampleBilinear} from './terrain.js';
import type {Terrain} from './terrain.js';

const byId = <T extends {id: string}>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export interface PlaceStats {
  lots: {tried: number; accepted: number; built: number; vacant: number; rejected: Record<string, number>};
  buildings: number; byStyle: Record<string, number>; floorsMax: number;
  props: Record<string, number>; propRejected: Record<string, number>; propRejectedTotal: number;
  trees: {street: number; zone: number; edge: number};
  parking: {lot: number; street: number; anchor: number; occupied: number};
  graph: GraphStats;
  green: GreenReport[];
  pads: number; padDevMax: number; padWithin04: number;
  colliders: {total: number; required: number};
  timingsMs: Record<string, number>;
}
export interface Assembled { compiled: Partial<CityCompiled>; extraRejected: {owner: string; code: string; msg: string}[]; stats: PlaceStats; terrainFinal: Terrain; buildings: PlacedBuilding[] }
const count = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

export function assemble(ctx: PlaceCtx, model: PlaceModel, roadTerrain: Terrain, withMask: boolean, T: Record<string, number>): Assembled {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);
  let t = now();
  const zones = [...model.zones.values()];
  const all: PlacedBuilding[] = [...model.explicit.buildings, ...zones.flatMap(z => z.buildings)].sort((a, b) => byId({id: a.src.id}, {id: b.src.id}));
  const pads: PadRec[] = [...model.explicit.pads, ...zones.flatMap(z => z.pads)];
  const terrain = cloneTerrain(roadTerrain);
  applyPads(terrain, pads);
  let devMax = 0, within = 0;
  for (const b of all) { const d = Math.abs(sampleBilinear(terrain, b.obb.cx, b.obb.cz) - (b.src.groundY ?? 0)); devMax = Math.max(devMax, d); if (d <= 0.4) within++; }
  const tCompiled = encodeTerrainCompiled(terrain, withMask);
  T.pads = Math.round(now() - t); t = now();

  const placements: Placement[] = [], colliders: Collider[] = [];
  for (const b of all) { placements.push(buildingPlacement(b)); colliders.push(buildingCollider(b)); }
  const props = model.props.slice().sort(byId);
  const propCount: Record<string, number> = {};
  for (const p of props) { placements.push(propPlacement(p)); colliders.push(propCollider(p)); count(propCount, p.kind); }
  const zoneTrees = zones.flatMap(z => model.trees.get(z.zone.id) ?? []);
  for (const z of ctx.src.zones) if (!model.zones.has(z.id)) zoneTrees.push(...(model.trees.get(z.id) ?? []));
  const trees = [...new Set([...zoneTrees, ...model.edge])].sort(byId);
  for (const tr of trees) { placements.push(tr); colliders.push(treeCollider(tr)); }
  T.placements = Math.round(now() - t); t = now();

  const lotSlots = zones.flatMap(z => z.slots), street = [...model.streetPark.entries()].sort((a, b) => a[0] - b[0]).flatMap(e => e[1]);
  const parking: ParkingSlotOut[] = [...lotSlots, ...street, ...model.anchorPark].sort(byId);
  const gr = buildGraph(ctx, model.doors);
  T.graph = Math.round(now() - t);

  const srcB: BuildingSource[] = all.map(b => b.src);
  const lots = zones.flatMap(z => z.lots).sort(byId);
  const built = new Set(all.map(b => b.lot));
  const parcels: CompiledParcel[] = lots.map(l => ({id: l.id, zone: l.zone, road: l.road, side: l.side, x: rnd(l.cx), z: rnd(l.cz), w: rnd(l.w), d: rnd(l.d), rot: rnd(Math.atan2(-l.uz, l.ux) * 180 / Math.PI), building: built.has(l.id)}));
  const extra: Assembled['extraRejected'] = [];
  const lotRej: Record<string, number> = {};
  for (const z of zones) for (const r of z.rej) { extra.push(r); count(lotRej, r.code); }
  for (const r of model.explicit.rej) extra.push(r);
  for (const w of model.explicit.warns) extra.push({owner: w.split(':')[0], code: 'site-warning', msg: w});
  const propRej: Record<string, number> = {};
  for (const r of model.propRej) { extra.push({owner: `${r.profile}@${r.road}`, code: r.code, msg: r.msg}); count(propRej, r.code); }
  extra.push(...gr.rej);
  const green = [...model.green.values()];
  for (const g of green) if (g.shortfall) extra.push({owner: g.zone, code: 'green-shortfall', msg: `녹지율 ${(g.coverage * 100).toFixed(1)}% 가 하한 ${(g.lo * 100).toFixed(0)}% 에 못 미친다 (가용 ${Math.round(g.availM2)}㎡)`});
  const byStyle: Record<string, number> = {};
  for (const b of all) count(byStyle, b.src.style);
  const stats: PlaceStats = {
    lots: {tried: zones.reduce((s, z) => s + z.tried, 0), accepted: lots.length, built: built.size, vacant: zones.reduce((s, z) => s + z.plans.filter(p => p.vacant).length, 0), rejected: lotRej},
    buildings: all.length, byStyle, floorsMax: all.reduce((m, b) => Math.max(m, b.src.floors), 0),
    props: propCount, propRejected: propRej, propRejectedTotal: model.propRej.length,
    trees: {street: props.filter(p => p.kind === 'tree').length, zone: zoneTrees.length, edge: model.edge.length},
    parking: {lot: lotSlots.length, street: street.length, anchor: model.anchorPark.length, occupied: parking.filter(p => p.vehicleId).length},
    graph: gr.stats, green, pads: pads.length, padDevMax: rnd(devMax), padWithin04: all.length ? within / all.length : 1,
    colliders: {total: colliders.length, required: colliders.filter(c => c.required).length}, timingsMs: T,
  };
  const compiled: Partial<CityCompiled> = {terrain: tCompiled, placements, colliders, graph: gr.graph, parking, buildings: srcB, parcels};
  return {compiled, extraRejected: extra, stats, terrainFinal: terrain, buildings: all};
}
