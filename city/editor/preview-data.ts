// 3D 미리보기용 자료 수집(순수): 보는 중심 주변 지형 높이 격자, 도로 중심선(xyz), 건물 상자, 앵커. three 에 의존하지 않는다.
import {sampleBilinear} from '../gen/terrain.js';
import {SCALE} from '../city-schema.js';
import {compiledFresh} from './io.js';
import {dense, roadWidthM} from './roadops.js';
import {ed} from './state.js';
import {currentTerrain} from './terrain-ed.js';

export interface PvRoad { id: string; cls: string; w: number; xyz: number[] }
export interface PvBld { id: string; x: number; y: number; z: number; w: number; d: number; h: number; rot: number; style: string }
export interface PvData {
  cx: number; cz: number; R: number; n: number; step: number; x0: number; z0: number;
  heights: Float32Array; minY: number; maxY: number;
  roads: PvRoad[]; buildings: PvBld[]; anchors: Array<{id: string; x: number; y: number; z: number; fixed: boolean}>;
  /** compiled = 최신 컴파일 결과의 도로·건물, estimate = 편집 중 원본에서 추정 */
  src: 'compiled' | 'estimate';
}
export function buildPvData(cx: number, cz: number, R: number): PvData | null {
  const t = currentTerrain(), doc = ed.doc;
  if (!t || !doc) return null;
  const step = Math.max(t.cell, R / 60), n = Math.floor((2 * R) / step), x0 = cx - R, z0 = cz - R;
  const heights = new Float32Array((n + 1) * (n + 1));
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const y = sampleBilinear(t, x0 + i * step, z0 + j * step); heights[j * (n + 1) + i] = y; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const fresh = compiledFresh() === true && !!ed.compiled?.geo, geo = ed.compiled?.geo;
  const inside = (x: number, z: number) => Math.abs(x - cx) <= R && Math.abs(z - cz) <= R;
  const roads: PvRoad[] = [];
  for (const r of doc.roads) {
    if (!Array.isArray(r.pts) || r.pts.length < 2) continue;
    const xyz: number[] = [];
    const cr = fresh ? geo!.roads.find(q => q.id === r.id) : undefined;
    if (cr) { for (let i = 0; i < cr.xyz.length; i += 3) if (inside(cr.xyz[i], cr.xyz[i + 2])) xyz.push(cr.xyz[i], cr.xyz[i + 1], cr.xyz[i + 2]); }
    else { const d = dense(r); for (let i = 0; i < d.n; i += 2) if (inside(d.x[i], d.z[i])) xyz.push(d.x[i], sampleBilinear(t, d.x[i], d.z[i]) + 0.15, d.z[i]); }
    if (xyz.length >= 6) roads.push({id: r.id, cls: r.cls, w: roadWidthM(r), xyz});
  }
  const bl: PvBld[] = [], seen = new Set<string>();
  const push = (b: {id: string; x: number; z: number; w: number; d: number; rot: number; floors: number; style: string; groundY?: number}) => {
    if (!inside(b.x, b.z) || seen.has(b.id)) return;
    seen.add(b.id);
    const y = b.groundY ?? sampleBilinear(t, b.x, b.z), fh = (SCALE.floorH as Record<string, number>)[b.style] ?? 3.8;
    bl.push({id: b.id, x: b.x, y, z: b.z, w: b.w, d: b.d, h: Math.max(1, b.floors) * fh, rot: b.rot, style: b.style});
  };
  for (const b of doc.buildings ?? []) push({...b, groundY: b.groundY ?? undefined});
  if (fresh) for (const b of geo!.buildings) push(b);
  const anchors = (doc.anchors ?? []).filter(a => inside(a.x, a.z)).map(a => ({id: a.id, x: a.x, y: a.y ?? sampleBilinear(t, a.x, a.z), z: a.z, fixed: a.fixed}));
  return {cx, cz, R, n, step, x0, z0, heights, minY, maxY, roads, buildings: bl, anchors, src: fresh ? 'compiled' : 'estimate'};
}
