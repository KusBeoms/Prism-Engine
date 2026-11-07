// 구역 브러시(순수): 스트로크 하나를 구역 배열에 적용해 새 배열을 돌려준다. 규칙은 docs/tech/CITY_EDITOR.md "구역 브러시".
//  extend : 시작점이 속한 구역을 확장(용도·이름·밀도 유지), 닿은 다른 구역은 그 부분을 잃는다(칠한 구역이 이김)
//  new    : 빈 곳 시작 → 선택한 용도의 새 구역, 닿은 다른 구역은 그 부분을 잃는다
//  erase  : ⌥ — 닿은 모든 구역에서 칠한 부분 제거. 갈라지면 분리, 비면 삭제
// 구멍(링)은 스키마가 표현하지 못하므로 메운다 → 구역 한가운데를 지워도 그대로(가장자리·갈라짐만 반영).
import {LIMITS, type Pt, type ZoneSource, type ZoneUse} from '../city-schema.js';
import {bboxOf, cloneMask, components, count, fillHoles, fixPinch, intersects, makeGrid, newMask, rasterPoly, ringToPoly, sameMask, stamp, subtract, traceOuter, union, type Mask} from './zone-raster.js';

export type BrushMode = 'extend' | 'new' | 'erase';
export interface BrushRes { zones: ZoneSource[]; changed: boolean; msg: string; focus?: string }
const MIN_CELLS = 4;

/** 마스크 → 다각형들(큰 순). 실패하면 null */
function partsOf(m: Mask): {polys: Pt[][]; filled: number; dropped: number} | null {
  fixPinch(m);
  const filled = fillHoles(m), polys: Pt[][] = [];
  let dropped = 0;
  for (const c of components(m)) {
    if (count(c) < MIN_CELLS) { dropped++; continue; }
    const poly = ringToPoly(traceOuter(c), m.g.cell);
    if (!poly) return null;
    polys.push(poly);
  }
  return {polys, filled, dropped};
}
const bbIntersect = (a: number[], b: number[]) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);

export function paintZones(zones: ZoneSource[], stroke: Pt[], r: number, mode: BrushMode, targetId: string | null, use: ZoneUse): BrushRes {
  const pad = r + 4, sb = bboxOf(stroke), brushBB: [number, number, number, number] = [sb[0] - pad, sb[1] - pad, sb[2] + pad, sb[3] + pad];
  const out: ZoneSource[] = zones.map(z => z);
  const ids = new Set(zones.map(z => z.id));
  const uid = (base: string) => { for (let i = 1; ; i++) { const id = `${base}-${i}`; if (!ids.has(id)) { ids.add(id); return id; } } };
  const info = {extended: 0, created: 0, shaved: 0, split: 0, removed: 0, swallowed: 0, failed: 0};
  let focus: string | undefined, changed = false;

  // 1) 칠하기: 대상 구역 확장 / 새 구역
  let skipId: string | null = null;
  if (mode === 'extend' || mode === 'new') {
    const Z = mode === 'extend' ? zones.find(z => z.id === targetId) : undefined;
    const g = makeGrid(Z ? bboxOf([...Z.poly, [brushBB[0], brushBB[1]], [brushBB[2], brushBB[3]]]) : brushBB);
    const m = Z ? rasterPoly(Z.poly, g) : newMask(g), orig = cloneMask(m), bm = newMask(g);
    stamp(bm, stroke, r); union(m, bm);
    if (!Z || !sameMask(orig, m)) {
      const pr = partsOf(m);
      if (!pr || !pr.polys.length) return {zones, changed: false, msg: '구역 모양을 만들지 못했습니다 (점이 너무 많거나 겹침) — 반경을 줄이거나 나눠 칠하세요'};
      if (Z) {
        const i = out.indexOf(Z);
        out[i] = {...Z, poly: pr.polys[0]};
        pr.polys.slice(1).forEach((p, k) => out.splice(i + 1 + k, 0, {...Z, id: uid(`${Z.id}-s`), poly: p}));
        info.extended++; focus = Z.id; skipId = Z.id;
      } else {
        const id = uid('new-zone');
        out.push({id, use, poly: pr.polys[0]}); info.created++; focus = id; skipId = id;
      }
      changed = true;
    } else { skipId = Z.id; focus = Z.id; }
  }
  // 2) 닿은 다른 구역에서 칠한 부분 제거 (지우개는 모든 구역)
  for (const z of [...out]) {
    if (z.id === skipId || !Array.isArray(z.poly) || z.poly.length < 3 || !bbIntersect(bboxOf(z.poly), brushBB)) continue;
    const g = makeGrid(bboxOf(z.poly)), m = rasterPoly(z.poly, g), orig = cloneMask(m), bm = newMask(g);
    stamp(bm, stroke, r);
    if (!intersects(m, bm)) continue;
    subtract(m, bm);
    const probe = cloneMask(m); fixPinch(probe); fillHoles(probe);
    if (sameMask(probe, orig)) { info.swallowed++; continue; } // 구멍으로 남을 부분뿐 → 변화 없음
    const pr = partsOf(m);
    if (!pr) { info.failed++; continue; }
    const i = out.indexOf(z);
    if (!pr.polys.length) { out.splice(i, 1); info.removed++; changed = true; continue; }
    out[i] = {...z, poly: pr.polys[0]};
    pr.polys.slice(1).forEach((p, k) => out.splice(i + 1 + k, 0, {...z, id: uid(`${z.id}-s`), poly: p}));
    if (pr.polys.length > 1) info.split++; else info.shaved++;
    changed = true;
  }
  if (out.length > LIMITS.zones) return {zones, changed: false, msg: `구역이 ${LIMITS.zones}개를 넘어 취소했습니다`};
  const parts: string[] = [];
  if (info.created) parts.push(`새 구역 ${focus}`);
  if (info.extended) parts.push(`구역 ${focus} 확장`);
  if (info.shaved) parts.push(mode === 'erase' ? `구역 ${info.shaved}개에서 제거` : `다른 구역 ${info.shaved}개에서 겹침 제거`);
  if (info.split) parts.push(`${info.split}개 구역 분리`);
  if (info.removed) parts.push(`${info.removed}개 구역 삭제(비어서)`);
  if (info.swallowed) parts.push(mode === 'erase' && !changed ? '구멍은 만들 수 없어 그대로 (구역 가장자리에서 지우세요)' : `구멍이 될 부분 ${info.swallowed}곳은 유지`);
  if (info.failed) parts.push(`${info.failed}개 구역은 점이 너무 많아 건너뜀`);
  return {zones: changed ? out : zones, changed, msg: parts.join(' · '), focus: changed ? focus : undefined};
}
