// 녹지: 구역 녹지율 목표(표면적 기준)에 맞춰 수관 투영이 목표 비율이 될 때까지 시드 푸아송 원반 후보에 나무를 심는다 + 도시 경계 안쪽 숲 띠.
// 측정 지표(coverage): 구역 다각형 안에서 "가용 칸" = 도로(포장+보도, 식재대는 포함)·건물 발자국·주차칸·교차로·물 구역을 뺀 칸(2.5m 격자 중심) 중
// 수관 원반(가로수 포함, 수관 반경 = 수종 범위×크기 변이)에 덮인 칸의 비율. 구역별 하위 시드 (seed,'green',zoneId) 로 난수를 써서 다른 구역과 독립이다.
import type {GreenRule, ZoneSource} from '../city-schema.js';
import type {Placement} from '../city-compiled.js';
import {pointInPolygon, distToPolyline} from './geom.js';
import type {P2} from './geom.js';
import {COVERAGE, SPECIES, STYLE_CFG, zoneStyle} from './place-cfg.js';
import type {PlaceCtx} from './place-ctx.js';
import type {PropRec, SightAxis} from './place-types.js';
import {rngFor} from './rng.js';
import type {Rng} from './rng.js';
import {slopeAt} from './terrain.js';
import {treeBlocks} from './sight.js';

const r2 = (v: number): number => Math.round(v * 100) / 100;
export const CELL = 2.5;
export const TREE_MAX_SLOPE = 0.4;
export interface GreenReport { zone: string; key: string; target: number; lo: number; hi: number; coverage: number; availM2: number; trees: number; shortfall: boolean }
export interface GreenOut { trees: Placement[]; report: GreenReport[] }
const NAMES = ['round', 'pine'];
const meanCrown = (name: string): number => { const c = SPECIES[name].crown; return (c[0] + c[1]) / 2; };
const crownOfAsset = (asset: string): number => meanCrown(asset.includes('pine') ? 'pine' : 'round');

/** 구역의 녹지율 키: 건물 양식(주택/아파트/고층...) 또는 용도 */
export function coverageKey(z: ZoneSource): string {
  const st = zoneStyle(z);
  if (st && COVERAGE[st]) return st;
  return COVERAGE[z.use] ? z.use : 'residential';
}
function ruleFor(rules: GreenRule[], z: ZoneSource): GreenRule | undefined {
  return rules.find(r => r.zone === z.id) ?? rules.find(r => !r.zone && r.zoneUse === z.use && (r.kind === 'lawn' || r.kind === 'forest' || r.kind === 'shrub'));
}
class Grid {
  x0: number; z0: number; cols: number; rows: number; avail: Uint8Array; cov: Uint8Array;
  constructor(bb: [number, number, number, number]) {
    this.x0 = bb[0]; this.z0 = bb[1]; this.cols = Math.max(1, Math.ceil((bb[2] - bb[0]) / CELL)); this.rows = Math.max(1, Math.ceil((bb[3] - bb[1]) / CELL));
    this.avail = new Uint8Array(this.cols * this.rows); this.cov = new Uint8Array(this.cols * this.rows);
  }
  /** 수관 원반을 덮고 새로 덮인 가용 칸 수를 돌려준다 */
  stamp(x: number, z: number, r: number): number {
    let n = 0;
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / CELL)), i1 = Math.min(this.cols - 1, Math.floor((x + r - this.x0) / CELL));
    const j0 = Math.max(0, Math.floor((z - r - this.z0) / CELL)), j1 = Math.min(this.rows - 1, Math.floor((z + r - this.z0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = this.x0 + (i + 0.5) * CELL, cz = this.z0 + (j + 0.5) * CELL;
      if ((cx - x) ** 2 + (cz - z) ** 2 > r * r) continue;
      const k = j * this.cols + i;
      if (this.avail[k] && !this.cov[k]) { this.cov[k] = 1; n++; }
    }
    return n;
  }
}
const bboxOf = (p: P2[]): [number, number, number, number] => { const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]; for (const q of p) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); } return b; };

/** 나무 후보가 놓일 수 있는가: 도로(수관 여유 0.8)·교차로·건물/주차/소품·경사·경계·시선 */
function treeOk(ctx: PlaceCtx, axes: SightAxis[], x: number, z: number, trunk: number, h: number, clr: number): boolean {
  if (!ctx.inBounds(x, z) || ctx.inJunction(x, z) >= 0) return false;
  for (const t of ctx.hits(x, z, trunk)) if (t.dist - trunk < t.e5 + 0.8) return false;
  if (slopeAt(ctx.terrain, x, z) > TREE_MAX_SLOPE) return false;
  if (ctx.obstacles(x, z, trunk + clr, -1e9, 1e9, ['building', 'parking', 'prop']).length) return false;
  return !treeBlocks(ctx, axes, x, z, ctx.groundY(x, z) + h);
}
function mkTree(ctx: PlaceCtx, id: string, owner: string, rng: Rng, name: string, x: number, z: number): {pl: Placement; crown: number; trunk: number} {
  const sp = SPECIES[name], crown = rng.range(sp.crown[0], sp.crown[1]), scale = crown / meanCrown(name), trunk = sp.trunk * scale;
  const y = ctx.groundY(x, z);
  return {pl: {id, asset: sp.asset, kind: 'tree', x: r2(x), y: r2(y), z: r2(z), rot: r2(rng.range(0, 360)), scale: r2(scale), owner}, crown, trunk};
}

export function greenZones(ctx: PlaceCtx, zones: ZoneSource[], streetTrees: PropRec[], axes: SightAxis[], only?: Set<string>): GreenOut {
  const trees: Placement[] = [], report: GreenReport[] = [], cap = ctx.opts.maxTrees ?? 80000;
  const water = zones.filter(z => z.use === 'water');
  for (const zone of zones) {
    if (zone.use === 'water' || (only && !only.has(zone.id))) continue;
    const key = coverageKey(zone), tab = COVERAGE[key], rule = ruleFor(ctx.src.greenery, zone);
    const target = ctx.opts.coverage?.[zone.id] ?? ctx.opts.coverage?.[key] ?? rule?.coverage ?? tab[1];
    const poly = zone.poly as P2[], bb = bboxOf(poly), g = new Grid(bb), rng = rngFor(ctx.src.seed, 'green', zone.id);
    let availN = 0;
    for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) {
      const x = g.x0 + (i + 0.5) * CELL, z = g.z0 + (j + 0.5) * CELL;
      if (!pointInPolygon(x, z, poly) || water.some(w => pointInPolygon(x, z, w.poly as P2[])) || ctx.inJunction(x, z) >= 0) continue;
      if (ctx.hits(x, z, 0).some(h => h.dist < h.e4)) continue;
      if (ctx.obstacles(x, z, 0.4, -1e9, 1e9, ['building', 'parking']).length) continue;
      g.avail[j * g.cols + i] = 1; availN++;
    }
    let covered = 0;
    for (const t of streetTrees) if (t.x > bb[0] - 6 && t.x < bb[2] + 6 && t.z > bb[1] - 6 && t.z < bb[3] + 6) covered += g.stamp(t.x, t.z, crownOfAsset(t.asset) * t.scale);
    let n = 0;
    if (availN > 0 && covered / availN < target && trees.length < cap) {
      // 푸아송 원반(다트 던지기): 공원·자연은 촘촘, 마당은 성기게
      const dense = zone.use === 'park' || zone.use === 'nature', rmin = dense ? 3.0 : zone.use === 'residential' || zone.use === 'farm' ? 4.5 : 5.5;
      const mix = zone.use === 'nature' ? [0.4, 0.6] : zone.use === 'park' ? [0.7, 0.3] : [0.85, 0.15];
      const species = rule?.species?.filter(s => SPECIES[s]) ?? [];
      const cell = rmin / Math.SQRT2, gw = Math.max(1, Math.ceil((bb[2] - bb[0]) / cell)), gh = Math.max(1, Math.ceil((bb[3] - bb[1]) / cell)), grid = new Map<number, P2[]>();
      const darts = Math.min(60000, Math.ceil(3 * ((bb[2] - bb[0]) * (bb[3] - bb[1])) / (rmin * rmin)));
      void gw; void gh;
      const clr = rule?.clearance ?? 1.2;
      for (let d = 0; d < darts && covered / availN < target && trees.length < cap && n < 4000; d++) {
        const x = rng.range(bb[0], bb[2]), z = rng.range(bb[1], bb[3]);
        const ci = Math.floor((x - bb[0]) / cell), cj = Math.floor((z - bb[1]) / cell);
        let near = false;
        for (let a = ci - 2; a <= ci + 2 && !near; a++) for (let b = cj - 2; b <= cj + 2 && !near; b++) for (const q of grid.get(a * 100003 + b) ?? []) if ((q[0] - x) ** 2 + (q[1] - z) ** 2 < rmin * rmin) { near = true; break; }
        if (near || !pointInPolygon(x, z, poly)) continue;
        const ai = Math.floor((x - g.x0) / CELL), aj = Math.floor((z - g.z0) / CELL);
        if (!g.avail[aj * g.cols + ai]) continue;
        const name = species.length ? rng.pick(species) : rng.chance(mix[0]) ? NAMES[0] : NAMES[1];
        const t = mkTree(ctx, `tr-${zone.id}-${n}`, `zone:${zone.id}`, rng, name, x, z);
        if (!treeOk(ctx, axes, x, z, t.trunk, SPECIES[name].h * (t.crown / meanCrown(name)), clr)) continue;
        const k = ci * 100003 + cj; (grid.get(k) ?? grid.set(k, []).get(k)!).push([x, z]);
        covered += g.stamp(x, z, t.crown); n++;
        trees.push(t.pl);
        ctx.addObstacle({owner: t.pl.id, kind: 'prop', cx: x, cz: z, r: t.trunk, y0: t.pl.y, y1: t.pl.y + 6});
      }
    }
    report.push({zone: zone.id, key, target, lo: tab[0], hi: tab[2], coverage: availN ? covered / availN : 0, availM2: availN * CELL * CELL, trees: n, shortfall: availN > 0 && covered / availN < Math.min(target, tab[0]) - 1e-9});
  }
  return {trees, report};
}

/** 도시 경계 안쪽 숲 띠(폭 band m): 경계를 따라 후보를 뿌리고 침엽수를 더 섞어 산으로 이어 붙인다. 건축 구역(buildable)·도로·건물과는 겹치지 않는다 */
export function edgeForest(ctx: PlaceCtx, zones: ZoneSource[], axes: SightAxis[], budget: number): Placement[] {
  const band = ctx.opts.edgeBand ?? 22, out: Placement[] = [];
  if (band <= 0) return out;
  const rng = rngFor(ctx.src.seed, 'green', '~edge'), b = ctx.bounds, build = zones.filter(z => z.use !== 'park' && z.use !== 'nature' && z.use !== 'water');
  const boxes = build.map(z => bboxOf(z.poly as P2[]));
  let n = 0;
  for (let e = 0; e < b.length && out.length < budget; e++) {
    const a = b[e], c = b[(e + 1) % b.length], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L < 1) continue;
    const tx = (c[0] - a[0]) / L, tz = (c[1] - a[1]) / L;
    let nx = -tz, nz = tx;
    const mx = (a[0] + c[0]) / 2 + nx * 2, mz = (a[1] + c[1]) / 2 + nz * 2;
    if (!ctx.inBounds(mx, mz)) { nx = -nx; nz = -nz; }
    for (let t = 0; t < L && out.length < budget; t += 2.6) for (let row = 0; row < 3; row++) {
      const d = rng.range(1.2, band), u = t + rng.range(-1.3, 1.3), x = a[0] + tx * u + nx * d, z = a[1] + tz * u + nz * d;
      if (!ctx.inBounds(x, z) || distToPolyline(x, z, [...b, b[0]]) < 1.0) continue;
      if (build.some((zn, k) => x >= boxes[k][0] && x <= boxes[k][2] && z >= boxes[k][1] && z <= boxes[k][3] && pointInPolygon(x, z, zn.poly as P2[]))) continue;
      const name = rng.chance(0.4 + 0.3 * (1 - d / band)) ? 'pine' : 'round', tr = mkTree(ctx, `te-${n}`, 'zone:~edge', rng, name, x, z);
      if (!treeOk(ctx, axes, x, z, tr.trunk, SPECIES[name].h, 2.0)) continue;
      n++; out.push(tr.pl);
      ctx.addObstacle({owner: tr.pl.id, kind: 'prop', cx: x, cz: z, r: tr.trunk, y0: tr.pl.y, y1: tr.pl.y + 6});
    }
  }
  return out;
}
export { STYLE_CFG };
