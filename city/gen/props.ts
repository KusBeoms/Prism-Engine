// 소품 자동 배치(11-3): 도로 누적거리 s 위에서 한쪽(좌/우/중앙분리대)마다 "배치 가능한 연속 구간"을 구하고(교차로 팔·횡단보도·문·진입로·예약 구간을 뺀다),
// 구간 길이/목표 간격으로 개수를 정해 남는 길이를 간격에 고르게 나눈다(양 끝 여유 = 간격/2 → 끝에만 짧은 간격이 몰리지 않고 이웃 구간과 리듬이 이어진다).
// 우선순위: 신호기·표지판(교차로) → 가로등 → 가로수 → 벤치 → 휴지통 → 볼라드. 충돌하면 허용 이동폭 안에서 위치를 옮기고(탐색 상한 9회), 안 되면 사유와 함께 rejected.
// 최종 검사는 실제 자산 점유 반경으로 한다: 차도·연석(포장 끝+0.25)·교차로 금지 구역·상판 아래·경계·건물/주차/다른 소품·시선 축.
import type {RoadClass} from '../city-schema.js';
import {rngFor, subSeed} from './rng.js';
import {distToPolyline, pointInPolygon} from './geom.js';
import type {Rng} from './rng.js';
import {FOOT, SPECIES} from './place-cfg.js';
import type {Foot} from './place-cfg.js';
import type {PlaceCtx} from './place-ctx.js';
import {CURB_CLEAR} from './place-ctx.js';
import type {Interval, PropRec, PropRej, ReqKind} from './place-types.js';
import {PRIO, latFor} from './props-profiles.js';
import type {PropRule} from './props-profiles.js';
import {pointAt, sideEdges} from './roads.js';
import {treeBlocks} from './sight.js';
import type {SightAxis} from './place-types.js';

const RAD = Math.PI / 180;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const RANK: Record<RoadClass, number> = {expressway: 4, arterial1: 3, arterial2: 2, collector: 1, local: 0};
export interface DoorIv { ri: number; side: 'left' | 'right'; s: number; half: number }
export interface PropsResult { props: PropRec[]; rej: PropRej[] }
export interface PropsIn {
  rules: readonly PropRule[]; doors: DoorIv[]; drives: Map<number, Interval[]>; axes: SightAxis[];
  /** 재빌드용: 이 (도로, 쪽)만 만든다. 생략하면 전부 */
  only?: (ri: number, side: 'left' | 'right' | 'median') => boolean;
}
type Side = 'left' | 'right' | 'median';

function footFor(kind: ReqKind, rule: PropRule, rng: Rng): {foot: Foot; asset: string; scale: number} {
  if (kind === 'tree') {
    const name = rng.pick(rule.species && rule.species.length ? rule.species : ['round']), sp = SPECIES[name] ?? (SPECIES[name.replace('tree.', '')] ?? SPECIES.round);
    const scale = rng.range(0.85, 1.25);
    return {foot: {r: sp.trunk * scale, h: sp.h * scale, asset: sp.asset}, asset: name.includes('.') ? name : sp.asset, scale: r2(scale)};
  }
  const f = FOOT[kind] ?? FOOT.bin;
  return {foot: f, asset: rule.asset ?? f.asset, scale: 1};
}

class Placer {
  props: PropRec[] = []; rej: PropRej[] = [];
  constructor(readonly ctx: PlaceCtx, readonly axes: SightAxis[]) {}
  /** 후보 하나를 검사. 통과하면 PropRec(등록됨), 아니면 사유 코드 */
  try(id: string, owner: string, profile: string, kind: ReqKind, ri: number, side: Side, s: number, lat: number, asset: string, foot: Foot, scale: number, rng: Rng): PropRec | string {
    const ctx = this.ctx, r = ctx.roads[ri], p = pointAt(r, s), right = side !== 'left', ls = right ? lat : -lat;
    const x = p.x - p.tz * ls, z = p.z + p.tx * ls, e = sideEdges(p.sec, 0, right);
    const y = p.y + (side === 'median' ? 0.15 : lat > e.e4 ? 0.05 : 0.15);
    if (!ctx.inBounds(x, z)) return 'outside-bounds';
    if (side === 'median') { for (const h of ctx.hits(x, z, foot.r)) if (h.ri !== ri && h.layer === 0 && h.dist - foot.r < h.e3 + CURB_CLEAR) return 'on-carriageway'; }
    else if (ctx.onPavement(x, z, foot.r, 0)) return 'on-carriageway';
    if (kind === 'signal' || kind === 'sign') {
      // 신호기·표지는 교차로 입구 보도에 서므로 보도 여유 구역이 아니라 실제 포장 다각형(과 반경)만 피한다
      for (const jk of ctx.junctionsNear(x, z, foot.r + 1)) {
        const poly = ctx.juncs[jk].polygon;
        if (poly.length >= 3 && (pointInPolygon(x, z, poly) || distToPolyline(x, z, [...poly, poly[0]]) < foot.r + 0.1)) return 'junction-corner';
      }
    } else if (ctx.inJunction(x, z) >= 0) return 'junction-corner';
    if (ctx.underDeck(x, z, y, foot.h)) return 'under-structure';
    const ob = ctx.obstacles(x, z, foot.r + 0.3, y - 0.2, y + foot.h, ['building', 'parking', 'prop']);
    if (ob.length) return `blocked-by-${ob[0].kind}`;
    if (kind === 'tree' && treeBlocks(ctx, this.axes, x, z, y + foot.h)) return 'sight-axis';
    // 방향: 가로등 팔·벤치 앞면은 도로(중심선) 쪽, 표지·신호는 접근 차량 쪽(호출자가 rot 덮어씀), 나머지 무작위
    const dx = right ? p.tz : -p.tz, dz = right ? -p.tx : p.tx;
    const rot = kind === 'lamp' ? Math.atan2(-dz, dx) / RAD : kind === 'bench' ? Math.atan2(dx, dz) / RAD : rng.range(0, 360);
    const rec: PropRec = {id, owner, profile, kind, road: r.id, ri, side, s: r2(s), lat: r2(lat), x: r2(x), y: r2(y), z: r2(z), rot: r2(rot), asset, r: r2(foot.r), h: foot.h, scale};
    if (kind === 'bench') rec.obb = {cx: rec.x, cz: rec.z, hw: foot.hw!, hd: foot.hd!, rot: rec.rot};
    this.props.push(rec);
    ctx.addObstacle({owner: id, kind: 'prop', cx: rec.x, cz: rec.z, r: foot.r, y0: y, y1: y + foot.h});
    return rec;
  }
}

/** 구간 길이 l 에 대한 개수·간격. 끝 여유 = 간격/2 */
export function layout(l: number, min: number, target: number, max: number): {n: number; g: number} | null {
  let n = Math.max(1, Math.round(l / target)), g = l / n;
  for (let k = 0; k < 64 && n > 1 && g < min; k++) { n--; g = l / n; }
  for (let k = 0; k < 64 && g > max; k++) { n++; g = l / n; }
  if (n === 1 && l < min * 0.6) return null;
  return {n, g};
}
function mergeIv(a: [number, number][]): [number, number][] {
  a.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const v of a) { const l = out[out.length - 1]; if (l && v[0] <= l[1]) l[1] = Math.max(l[1], v[1]); else out.push([v[0], v[1]]); }
  return out;
}

export function placeProps(ctx: PlaceCtx, inp: PropsIn): PropsResult {
  const pl = new Placer(ctx, inp.axes), only = inp.only ?? (() => true);
  const seed = ctx.src.seed;
  // ── 1 교차로: 신호기·표지판 ──
  ctx.juncs.forEach(j => {
    const stop = j.arms.length >= 3 || j.kind === 'roundabout';
    const maxRank = Math.max(...j.arms.map(a => RANK[ctx.roads[ctx.byId.get(a.roadId)!].cls]));
    j.arms.forEach((a, ai) => {
      const ri = ctx.byId.get(a.roadId);
      if (ri === undefined) return;
      const r = ctx.roads[ri], signal = j.crosswalks.length > 0;
      if (r.cls === 'expressway' || (!signal && !stop) || (!signal && RANK[r.cls] === maxRank && j.arms.some(b => RANK[ctx.roads[ctx.byId.get(b.roadId)!].cls] < maxRank))) return;
      const side: Side = a.dir === 1 ? 'left' : 'right';
      if (!only(ri, side)) return;
      const s = a.sNode + a.dir * (a.trim + (signal ? 4.4 : 2.0));
      if (s < 1 || s > r.length - 1) return;
      const p = pointAt(r, s), e = sideEdges(p.sec, 0, side === 'right');
      const kind: ReqKind = signal ? 'signal' : 'sign', id = `${kind}.${j.id}.${ai}`;
      if (e.e4 - e.e3 < 1.2) { pl.rej.push({profile: `junction.${kind}`, kind, road: r.id, side, s, code: 'no-sidewalk', msg: '보도가 좁아 놓을 수 없다'}); return; }
      const rng = rngFor(seed, 'prop', id), f = footFor(kind, {} as PropRule, rng);
      const res = pl.try(id, `road:${r.id}`, `junction.${kind}`, kind, ri, side, s, e.e3 + (signal ? 0.7 : 0.6), f.asset, f.foot, 1, rng);
      if (typeof res === 'string') pl.rej.push({profile: `junction.${kind}`, kind, road: r.id, side, s, code: res, msg: `${j.id} 접근로 ${r.id} 의 ${kind} 를 놓지 못했다`});
      else { const t = pointAt(r, a.sNode + a.dir * 8), ux = t.x - pointAt(r, a.sNode).x, uz = t.z - pointAt(r, a.sNode).z; res.rot = r2(Math.atan2(ux, uz) / RAD); }
    });
  });
  // ── 2 프로필 ──
  const rules = inp.rules.slice().sort((a, b) => (a.prio ?? PRIO[a.kind] ?? 9) - (b.prio ?? PRIO[b.kind] ?? 9));
  ctx.roads.forEach((r, ri) => {
    const arms = ctx.arms.get(ri) ?? [];
    const rawFor = (side: 'left' | 'right') => {
      const out: {s0: number; s1: number; clr: boolean}[] = [];
      for (const d of inp.doors) if (d.ri === ri && d.side === side) out.push({s0: d.s - d.half, s1: d.s + d.half, clr: true});
      for (const d of inp.drives.get(ri) ?? []) if (d.side === side || d.side === 'both') out.push({s0: d.s0, s1: d.s1, clr: false});
      for (const rs of ctx.opts.reserve ?? []) if (rs.road === r.id && (!rs.side || rs.side === 'both' || rs.side === side)) out.push({s0: rs.s0, s1: rs.s1, clr: false});
      return out;
    };
    const raw = {left: rawFor('left'), right: rawFor('right')};
    for (const rule of rules) {
      if (rule.roadClass !== r.cls) continue;
      const kind = rule.kind as ReqKind, sides: Side[] = rule.side === 'median' ? ['median'] : rule.side === 'left' ? ['left'] : rule.side === 'right' ? ['right'] : ['left', 'right'];
      const stagger = rule.side === 'stagger', sp = rule.spacing, mult = stagger ? 2 : 1;
      for (const side of sides) {
        if (!only(ri, side)) continue;
        const right = side !== 'left', fp = footFor(kind, rule, rngFor(seed, 'probe', rule.id));
        const rad = kind === 'tree' ? 0.35 : fp.foot.hd ?? fp.foot.r;
        const forb: [number, number][] = arms.map(a => [a.s0 - rule.clearance, a.s1 + rule.clearance] as [number, number]);
        if (side !== 'median') for (const f of raw[side]) forb.push([f.s0 - (f.clr ? rule.clearance : 0), f.s1 + (f.clr ? rule.clearance : 0)]);
        else for (const f of [...raw.left, ...raw.right]) if (!f.clr) forb.push([f.s0, f.s1]);
        const fm = mergeIv(forb), runs: [number, number][] = [];
        let a = -1, k = 0;
        for (let i = 0; i < r.n; i++) {
          const s = r.s[i];
          while (k < fm.length && fm[k][1] < s) k++;
          const seg = r.segs[r.segIdx[i]];
          const ok = seg.kind === 'ground' && seg.layer === 0 && !(k < fm.length && s >= fm[k][0]) && latFor(rule, r.sec.subarray(i * 9, i * 9 + 9), right, rad) !== null;
          if (ok) { if (a < 0) a = s; } else if (a >= 0) { runs.push([a, r.s[i - 1]]); a = -1; }
        }
        if (a >= 0) runs.push([a, r.s[r.n - 1]]);
        let seq = 0;
        const sideKey = side === 'median' ? 'm' : side[0];
        for (const [sa, sb] of runs) {
          const lay = layout(sb - sa, sp.min * mult, sp.target * mult, sp.max * mult);
          if (!lay) continue;
          const pos: number[] = [];
          if (stagger && side === 'right') { for (let q = 0; q < lay.n - 1; q++) pos.push(sa + lay.g * (q + 1)); }
          else for (let q = 0; q < lay.n; q++) pos.push(sa + lay.g * (q + 0.5));
          const slack = Math.min(3, Math.max(0, Math.min(lay.g - sp.min * mult, sp.max * mult - lay.g) / 2));
          for (const s0 of pos) {
            const id = `${rule.id}.${r.id}.${sideKey}.${seq++}`, rng = rngFor(seed, 'prop', id), f = footFor(kind, rule, rng);
            let res: PropRec | string = 'none', first = '';
            const shifts = [0]; for (let d = 0.5; d <= slack + 1e-9 && shifts.length < 9; d += 0.5) shifts.push(d, -d);
            for (const d of shifts) {
              const s = s0 + d;
              if (s < sa + 0.3 || s > sb - 0.3) continue;
              const lat = latFor(rule, pointAt(r, s).sec, right, rad);
              if (lat === null) { res = 'no-room'; continue; }
              res = pl.try(id, `road:${r.id}`, rule.id, kind, ri, side, s, lat, f.asset, f.foot, f.scale, rng);
              if (typeof res !== 'string') break;
              if (!first) first = res;
            }
            if (typeof res === 'string') pl.rej.push({profile: rule.id, kind, road: r.id, side, s: r2(s0), code: first || res, msg: `${rule.id} @${r.id}:${r2(s0)} ${side}: ${first || res}`});
          }
        }
      }
    }
  });
  return {props: pl.props, rej: pl.rej};
}
export { subSeed };
