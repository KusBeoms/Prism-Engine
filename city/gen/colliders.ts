// 충돌체: 필수 종류(줄기·기둥·벤치·표지·신호기·휴지통·볼라드)는 소품 한 개당 충돌체 한 개(owner = 소품의 소유자), 건물은 발자국 전체 OBB(owner = 건물 id).
// 건물 벽 조각(문 개구부)은 INTERIOR 가 owner = 건물 id 로 교체한다. 울타리는 아직 생성하지 않는다(생성기에 울타리 규칙이 없음).
import type {Collider, Placement} from '../city-compiled.js';
import {SPECIES} from './place-cfg.js';
import type {PlacedBuilding, PropRec} from './place-types.js';

const r2 = (v: number): number => Math.round(v * 100) / 100;
export const REQUIRED = new Set(['tree', 'lamp', 'signal', 'sign', 'bench', 'bin', 'bollard']);
const trunkOf = (asset: string): number => (asset.includes('pine') ? SPECIES.pine.trunk : SPECIES.round.trunk);

export function propCollider(p: PropRec): Collider {
  const shape = p.obb ? {t: 'obb' as const, cx: p.obb.cx, cz: p.obb.cz, hw: p.obb.hw, hd: p.obb.hd, rotDeg: p.obb.rot} : {t: 'circle' as const, cx: p.x, cz: p.z, r: p.r};
  return {owner: p.owner, shape, y0: r2(p.y), y1: r2(p.y + Math.min(p.h, p.kind === 'tree' ? 3 : p.h)), required: true};
}
export function treeCollider(t: Placement): Collider {
  return {owner: t.owner, shape: {t: 'circle', cx: t.x, cz: t.z, r: r2(trunkOf(t.asset) * (t.scale ?? 1))}, y0: t.y, y1: r2(t.y + 3), required: true};
}
export function buildingCollider(b: PlacedBuilding): Collider {
  const y = b.src.groundY ?? b.src.interior.floorY ?? 0;
  return {owner: b.src.id, shape: {t: 'obb', cx: b.src.x, cz: b.src.z, hw: r2(b.src.w / 2), hd: r2(b.src.d / 2), rotDeg: b.src.rot}, y0: r2(y - 0.5), y1: r2(b.top), required: true};
}
export function propPlacement(p: PropRec): Placement {
  return {id: p.id, asset: p.asset, kind: p.kind, x: p.x, y: p.y, z: p.z, rot: p.rot, ...(p.scale !== 1 ? {scale: p.scale} : {}), owner: p.owner};
}
export function buildingPlacement(b: PlacedBuilding): Placement {
  return {id: b.src.id, asset: `building.${b.src.style}`, kind: 'building', x: b.src.x, y: r2(b.src.groundY ?? 0), z: b.src.z, rot: b.src.rot, owner: b.src.id};
}
