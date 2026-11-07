// 구역 단위 증분 재빌드: 도로·지형·교차로(prev.cache)를 그대로 쓰고, 지정 구역의 필지·건물·대지 주차·녹지와 그 구역 필지가 닿은 도로의 소품·도로변 주차만 다시 계산한다.
// 다른 구역/도로의 id·좌표는 prev 모델의 것을 그대로 유지한다(시험: id 안정). 도로/지형/앵커/소품 규칙 등 전역 입력이 바뀌었거나 다른 구역이 달라졌으면 전체 buildCity 로 되돌아간다(fullFallback).
// 한계: 그래프·충돌체·대지 평탄화는 조립 단계에서 전체를 다시 만든다(선형 비용, 결정적). 이웃 구역의 녹지율 통계는 가로수 변화를 반영하지 않는다.
import type {CitySource} from '../city-schema.js';
import {buildCity, finish, globalSigOf} from './build.js';
import type {CityBuildResult, CityOptions} from './build.js';
import {sourceHash} from './bytes.js';
import {PlaceCtx} from './place-ctx.js';
import {FREE_ZONE, registerBuilding, runZone} from './place.js';
import type {PlaceModel} from './place.js';
import type {Obb} from './obb.js';

const slotObb = (s: {x: number; z: number; rot: number; kind: string}): Obb => ({cx: s.x, cz: s.z, hw: s.kind === 'parallel' ? 1.15 : 1.25, hd: s.kind === 'parallel' ? 3.0 : 2.5, rot: s.rot});
export interface RebuildInfo { fullFallback: boolean; reason?: string; roads: string[]; ms: number }

export function rebuildZone(source: CitySource, prev: CityBuildResult, zoneId: string, opts?: CityOptions): CityBuildResult & {rebuild: RebuildInfo} {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0, c = prev.cache;
  const fall = (reason: string) => Object.assign(buildCity(source, opts ?? c?.opts ?? {}), {rebuild: {fullFallback: true, reason, roads: [], ms: Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - t0)}});
  if (!c) return fall('prev.cache 없음');
  if (globalSigOf(source) !== c.globalSig) return fall('도로·지형·전역 입력이 바뀌었다');
  for (const z of source.zones) if (z.id !== zoneId && c.zoneSig[z.id] !== sourceHash(z)) return fall(`다른 구역 ${z.id} 가 바뀌었다`);
  if (source.zones.length !== Object.keys(c.zoneSig).length - (c.zoneSig[zoneId] !== undefined && !source.zones.some(z => z.id === zoneId) ? 1 : 0) && source.zones.some(z => !(z.id in c.zoneSig) && z.id !== zoneId)) return fall('구역 목록이 바뀌었다');
  const popts = (opts ?? c.opts).place ?? {}, ctx = new PlaceCtx(source, c.roads, c.junctions, c.terrainRoads, popts), old = c.model, axes = c.axes;
  const m: PlaceModel = {zones: new Map(), explicit: old.explicit, streetPark: new Map(old.streetPark), anchorPark: old.anchorPark, props: old.props, propRej: old.propRej, trees: new Map(old.trees), green: new Map(old.green), edge: old.edge, doors: []};
  // 변하지 않는 것들의 점유를 다시 등록
  for (const b of old.explicit.buildings) registerBuilding(ctx, b);
  const oldRes = old.zones.get(zoneId), affected = new Set<number>();
  for (const l of oldRes?.lots ?? []) affected.add(l.ri);
  for (const [id, z] of old.zones) {
    if (id === zoneId) continue;
    m.zones.set(id, z);
    for (const l of z.lots) ctx.addObstacle({owner: l.id, kind: 'lot', obb: {cx: l.cx, cz: l.cz, hw: l.w / 2 - 0.05, hd: l.d / 2 - 0.05, rot: Math.atan2(-l.uz, l.ux) * 180 / Math.PI}, y0: -1e9, y1: 1e9});
    for (const b of z.buildings) registerBuilding(ctx, b);
    for (const s of z.slots) ctx.addObstacle({owner: s.id, kind: 'parking', obb: slotObb(s), y0: -1e9, y1: 1e9});
  }
  for (const [ri, ss] of m.streetPark) if (!affected.has(ri)) for (const s of ss) ctx.addObstacle({owner: s.id, kind: 'parking', obb: slotObb(s), y0: -1e9, y1: 1e9});
  for (const s of m.anchorPark) ctx.addObstacle({owner: s.id, kind: 'parking', obb: slotObb(s), y0: -1e9, y1: 1e9});
  for (const [id, ts] of m.trees) if (id !== zoneId) for (const t of ts) ctx.addObstacle({owner: t.id, kind: 'prop', cx: t.x, cz: t.z, r: 0.35 * (t.scale ?? 1), y0: t.y, y1: t.y + 6});
  for (const t of m.edge) ctx.addObstacle({owner: t.id, kind: 'prop', cx: t.x, cz: t.z, r: 0.35 * (t.scale ?? 1), y0: t.y, y1: t.y + 6});
  // 대상 구역 다시 계산
  const styleOver = new Map<string, import('../city-schema.js').BuildingStyle>();
  for (const e of source.exceptions) if (e.kind === 'style') styleOver.set(e.target, e.style);
  const zNew = source.zones.find(z => z.id === zoneId);
  if (zNew) { const r = runZone(ctx, zNew, axes, styleOver); m.zones.set(zoneId, r); for (const l of r.lots) affected.add(l.ri); }
  if (zoneId === FREE_ZONE) m.zones.delete(FREE_ZONE);
  m.trees.delete(zoneId); m.green.delete(zoneId);
  // 영향받은 도로의 소품·도로변 주차, 구역 녹지
  const { finishStreet } = placeMod;
  finishStreet(ctx, m, axes, {roads: affected}, new Set(zNew ? [zoneId] : []));
  const res = finish(source, opts ?? c.opts, c.base, ctx, m, axes);
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - t0);
  return Object.assign(res, {rebuild: {fullFallback: false, roads: [...affected].map(i => c.roads[i].id), ms}});
}
import * as placeMod from './place.js';
