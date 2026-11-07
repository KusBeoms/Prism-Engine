// 자동 필지 생성: 도로 한쪽의 "빈 구간"(교차로 팔·횡단보도·비지상·구역 밖 차감)을 구하고 그 안에 구역 양식의 전면 폭으로 채워 넣는다(나머지는 균등 분배).
// 기존의 "예약에 닿으면 필지 통째로 거부" 대신 모서리 필지는 교차로 쪽을 깎아 살린다. 구역 다각형이 얕으면 깊이를 줄여 시도한다.
// 둘째 줄(뒷줄) 필지: 앞줄 필지 바로 뒤에 같은 폭으로 놓고, 앞줄 건물을 한쪽으로 몰아 만든 폭 4.5m 통로(corridor)로 보도에 닿는다.
// 필지 id = `p-<구역>-<도로>-<l|r>-<s0 반올림 m>` (뒷줄은 `-b` 접미) — 위치에서 유도되어 다른 구역·도로의 변경에 흔들리지 않는다.
import type {BuildingStyle, ZoneSource} from '../city-schema.js';
import {pointInPolygon} from './geom.js';
import type {P2} from './geom.js';
import type {PlaceCtx} from './place-ctx.js';
import {FALLBACK, MIN_LOT_D, STYLE_CFG, fitSide} from './place-cfg.js';
import type {Lot} from './place-types.js';
import {checkLot, lotFrame, lotObb} from './parcels.js';
import type {LotRej} from './parcels.js';
import {pointAt, sideEdges} from './roads.js';
import {rngFor} from './rng.js';
import {infillLots} from './lotinfill.js';

const STEP = 2;
/** 통로 폭(m): 뒷줄 건물로 가는 앞줄 옆 보행 통로 */
export const CORRIDOR_W = 4.5;
const BACK_STYLES: ReadonlySet<BuildingStyle> = new Set(['house', 'shop', 'office', 'highrise']);
const bboxOf = (p: P2[]): [number, number, number, number] => { const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]; for (const q of p) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); } return b; };
/** 양식별 최소 전면 폭과 최소 깊이 */
export const minFront = (st: BuildingStyle): number => Math.max(STYLE_CFG[st].w[0] * 0.75, 7.2) + 3;
export const minDepth = (st: BuildingStyle): number => MIN_LOT_D[st];
/** 하향 사슬의 끝(가장 작은 양식)의 최소 깊이: 구간 탐색은 이 깊이로 한다 */
export const chainMinDepth = (st: BuildingStyle): number => { let s = st; while (FALLBACK[s]) s = FALLBACK[s]!; return MIN_LOT_D[s]; };
const DEPTH_F = [1, 0.85, 0.7, 0.55];

/** 도로 ri 의 한쪽에서 필지가 설 수 있는 s 구간들 */
export function freeRuns(ctx: PlaceCtx, ri: number, side: 'left' | 'right', zi: number, style: BuildingStyle): [number, number][] {
  const r = ctx.roads[ri], right = side === 'right', md = chainMinDepth(style), runs: [number, number][] = [];
  const n = Math.floor(r.length / STEP);
  let a = -1;
  const close = (i: number) => { if (a >= 0) runs.push([a * STEP, Math.min(r.length, i * STEP)]); a = -1; };
  for (let i = 0; i < n; i++) {
    const sm = (i + 0.5) * STEP, p = pointAt(r, sm), seg = r.segs[p.seg];
    let ok = seg.kind === 'ground' && seg.layer === 0;
    if (ok) {
      const e5 = sideEdges(p.sec, 0, right).e5;
      const fr = ctx.at(ri, sm, (right ? 1 : -1) * (e5 + 0.6));
      if (ctx.inJunctionLot(fr.x, fr.z) >= 0) ok = false;
      else for (const d of [0.6, 3, md / 2]) {
        const q = ctx.at(ri, sm, (right ? 1 : -1) * (e5 + 0.3 + d));
        // 다른 도로의 포장·보도가 앞면 근처를 덮으면 그 구간은 뺀다
        if (d < 4 && ctx.hits(q.x, q.z, 0.3).some(h => h.ri !== ri && h.dist < h.e5 + 0.3)) { ok = false; break; }
      }
      if (ok) for (const d of [3, md / 2]) {
        const c = ctx.at(ri, sm, (right ? 1 : -1) * (e5 + 0.3 + d));
        // 구역 다각형은 도로 중심선보다 안쪽에서 끝나는 경우가 많아 앞면 띠는 구역 검사에서 뺀다(중앙 깊이에서만 확인)
        if (!ctx.inBounds(c.x, c.z) || (d > 3 && ctx.zoneAt(c.x, c.z) !== zi)) { ok = false; break; }
      }
    }
    if (ok) { if (a < 0) a = i; } else close(i);
  }
  close(n);
  return runs;
}
/** 구간 길이 L 을 전면 폭 [min, 1.5*pitch] 로 균등 분할: 칸 수와 시작 오프셋 */
export function packRun(L: number, pitch: number, minF: number): number[] {
  if (L < minF) return [];
  let n = Math.max(1, Math.round(L / pitch));
  while (n > 1 && L / n < minF) n--;
  return Array.from({length: n + 1}, (_, k) => (L * k) / n);
}

/** 전면 중점(fx,fz)에서 안쪽(v) 으로 걸어 구역 밖·경계 밖·도로 포장·교차로·이미 있는 필지에 닿기 전까지의 거리. 전면 양 끝·중간 3열 중 최소 */
export function freeDepth(ctx: PlaceCtx, f: {ux: number; uz: number; vx: number; vz: number; w: number}, fx: number, fz: number, maxD: number, self: number, zoneFrom = 0): number {
  let best = maxD;
  for (const a of [-0.42, -0.2, 0, 0.2, 0.42]) {
    const x0 = fx + f.ux * f.w * a, z0 = fz + f.uz * f.w * a;
    for (let t = 1.0; t <= best; t += 1.5) {
      const x = x0 + f.vx * t, z = z0 + f.vz * t;
      let blocked = (t >= zoneFrom && !ctx.buildableAt(x, z)) || !ctx.inBounds(x, z) || ctx.inJunctionLot(x, z) >= 0 || ctx.obstacles(x, z, 0.05, -1e9, 1e9, ['lot', 'building']).length > 0;
      if (!blocked) for (const h of ctx.hits(x, z, 0.3)) if (h.dist < h.e5 + (h.ri === self ? 0.05 : 0.3)) { blocked = true; break; }
      if (blocked) { best = Math.min(best, t - 1.0); break; }
    }
  }
  return best;
}
const TRIMS: [number, number][] = [[0, 0], [2, 0], [0, 2], [2, 2], [4, 0], [0, 4], [4, 4], [6, 0], [0, 6], [6, 6], [8, 0], [0, 8], [10, 0], [0, 10]];
function tryLot(ctx: PlaceCtx, ri: number, side: 'left' | 'right', zone: string, style: BuildingStyle, s0: number, s1: number, share: boolean, mD = minDepth(style)): {lot?: Lot; rej?: LotRej} {
  const cfg = STYLE_CFG[style], r = ctx.roads[ri], minF = minFront(style);
  let lastRej: LotRej | undefined;
  for (const [da, db] of TRIMS) {
    const a = s0 + da, b = s1 - db;
    if (b - a < minF) break;
    const f0 = lotFrame(ctx, ri, side, a, b, cfg.depth);
    if (!f0) continue;
    // 전면 중점 = 중심에서 v 로 depth/2 되돌린 점. 안쪽 여유 깊이를 재서 필지 깊이를 정한다
    const fx = f0.cx - f0.vx * cfg.depth / 2, fz = f0.cz - f0.vz * cfg.depth / 2;
    const free = freeDepth(ctx, f0, fx, fz, cfg.depth * 1.6, ri, mD * 0.4);
    if (free < mD) { (globalThis as any).__nr?.(ctx, f0, fx, fz, free, mD, style, r.cls); lastRej = {owner: `p-${zone}-${r.id}-${side[0]}-${Math.round(a)}`, code: 'no-room', msg: `전면에서 안쪽 여유 깊이 ${free.toFixed(1)}m 가 최소 ${mD.toFixed(0)}m 미만(구역 밖·도로·교차로·다른 필지에 막힘)`}; continue; }
    // 맞은편 줄과 나눠 쓴다: 여유가 두 줄을 모두 채울 만큼 크면 한 줄 몫(절반)을, 아니면 최소 깊이 이상 전부를 쓴다
    const depth0 = free >= cfg.depth * 1.59 ? cfg.depth : Math.min(cfg.depth, share && free / 2 >= mD ? free / 2 : free);
    // 인접 필지·교차로와 겹치면 깊이를 줄여 다시 시도한다
    for (const df of [1, 0.8, 0.62, 0]) {
      const depth = Math.max(mD, depth0 * df);
      if (depth > depth0 + 1e-6) continue;
      const f = lotFrame(ctx, ri, side, a, b, depth);
      if (!f) break;
      const lot: Lot = {id: `p-${zone}-${r.id}-${side[0]}-${Math.round(a)}`, zone, road: r.id, ri, side, t0: a, t1: b, depth, cx: f.cx, cz: f.cz, ux: f.ux, uz: f.uz, vx: f.vx, vz: f.vz, w: f.w, d: depth, lat0: f.lat0, style, explicit: false, sMid: f.sMid, row: 0};
      const bad = checkLot(ctx, lot, true);
      if (!bad) return {lot};
      if (bad.code !== 'outside-zone') lastRej = {owner: lot.id, code: bad.code, msg: bad.msg};
      if (!['junction-reserve', 'road-overlap', 'lot-overlap', 'outside-zone'].includes(bad.code)) return {rej: lastRej};
    }
  }
  return lastRej ? {rej: lastRej} : {};
}
const reg = (ctx: PlaceCtx, l: Lot): void => ctx.addObstacle({owner: l.id, kind: 'lot', obb: {...lotObb(l), hw: l.w / 2 - 0.05, hd: l.d / 2 - 0.05}, y0: -1e9, y1: 1e9});

/** 구간 [a,b] 를 양식 style 의 칸으로 나눠 필지를 만든다. 칸이 안 서면 한 단계 작은 양식(FALLBACK)으로 같은 구간을 다시 나눈다 */
function fillRange(ctx: PlaceCtx, ri: number, side: 'left' | 'right', zone: string, style: BuildingStyle, a: number, b: number, share: boolean, out: {lots: Lot[]; rej: LotRej[]; tried: number}): void {
  const cuts = packRun(b - a, STYLE_CFG[style].pitch, minFront(style)), fb = FALLBACK[style];
  for (let k = 0; k + 1 < cuts.length; k++) {
    out.tried++;
    const res = tryLot(ctx, ri, side, zone, style, a + cuts[k], a + cuts[k + 1], share);
    if (res.lot) { out.lots.push(res.lot); reg(ctx, res.lot); }
    else if (fb) fillRange(ctx, ri, side, zone, fb, a + cuts[k], a + cuts[k + 1], share, out);
    else if (res.rej) out.rej.push(res.rej);
  }
  // 칸이 하나도 못 나오는 짧은 구간(minFront 미만)은 버린다
}
/** 뒷줄 최대 줄 수(앞줄 제외): 깊은 블록 안쪽을 통로로 이어 채운다 */
const MAX_BACK_ROWS = 3;
/** 필지 생성 단계: front = 도로변 앞줄, back = 앞줄 뒤 통로 줄(최대 3), infill = 블록 안쪽 채움, all = 한 구역에서 차례로(구역 단위 재빌드용).
 *  전체 빌드는 모든 구역의 front 를 먼저 끝낸 뒤 back → infill 순으로 돌려, 앞선 구역의 깊은 필지가 이웃 구역의 도로변을 먹지 않게 한다 */
export type LotPhase = 'all' | 'front' | 'back' | 'infill';
export function genLots(ctx: PlaceCtx, zone: ZoneSource, style: BuildingStyle, phase: LotPhase = 'all', prev: Lot[] = []): {lots: Lot[]; rej: LotRej[]; tried: number} {
  const cfg = STYLE_CFG[style], out = {lots: [] as Lot[], rej: [] as LotRej[], tried: 0}, zp = zone.poly as P2[], zb = bboxOf(zp), zi = ctx.src.zones.findIndex(z => z.id === zone.id), reach = cfg.depth * 1.2 + ctx.maxHW + cfg.pitch;
  if (phase === 'all' || phase === 'front') ctx.roads.forEach((r, ri) => {
    if (r.cls === 'expressway') return;
    const bb = ctx.roadBox[ri];
    if (bb[2] < zb[0] - reach || bb[0] > zb[2] + reach || bb[3] < zb[1] - reach || bb[1] > zb[3] + reach) return;
    for (const side of ['left', 'right'] as const) for (const [ra, rb] of freeRuns(ctx, ri, side, zi, style)) fillRange(ctx, ri, side, zone.id, style, ra, rb, true, out);
  });
  const {rej} = out, fronts = phase === 'back' ? prev.filter(l => !l.row) : out.lots.slice(), news: Lot[] = [];
  // 뒷줄: 앞줄 필지 뒤에 같은 폭으로 줄줄이(각 줄은 앞줄이 만든 통로 쪽으로 이어진다)
  if ((phase === 'all' || phase === 'back') && zone.use !== 'farm') {
    for (const f of fronts) {
      const fc = STYLE_CFG[f.style];
      if (!BACK_STYLES.has(f.style) || f.d < fc.depth * 0.84 || f.w - fitSide(f.style, f.w) - CORRIDOR_W < fc.w[0] * 0.9) continue;
      const c: 1 | -1 = rngFor(ctx.src.seed, 'cor', f.id).chance(0.5) ? 1 : -1;
      let prevRow = f;
      for (let row = 1; row <= MAX_BACK_ROWS; row++) {
        let lastBad: LotRej | undefined, placed: Lot | null = null;
        for (const df of DEPTH_F) {
          const d2 = fc.depth * df;
          if (d2 < minDepth(f.style)) break;
          const sh = prevRow.d / 2 + d2 / 2 + 0.06;
          const b: Lot = {...f, id: row === 1 ? `${f.id}-b` : `${f.id}-b${row}`, d: d2, depth: d2, cx: prevRow.cx + prevRow.vx * sh, cz: prevRow.cz + prevRow.vz * sh, lat0: prevRow.lat0 + prevRow.d, row, corridor: c, rowLast: true};
          out.tried += df === 1 ? 1 : 0;
          const bad = checkLot(ctx, b, true, f.ri);
          if (bad) { if (bad.code !== 'outside-zone') lastBad = {owner: b.id, code: bad.code, msg: bad.msg}; continue; }
          placed = b; lastBad = undefined; break;
        }
        if (!placed) { if (lastBad && row === 1) rej.push(lastBad); break; }
        f.corridor = c;
        if (prevRow !== f) prevRow.rowLast = false;
        news.push(placed); reg(ctx, placed);
        prevRow = placed;
      }
    }
  }
  if (phase === 'back') out.lots = news; else out.lots.push(...news);
  if (phase === 'all' || phase === 'infill') infillLots(ctx, zone, zi, style, out, l => reg(ctx, l));
  return out;
}
