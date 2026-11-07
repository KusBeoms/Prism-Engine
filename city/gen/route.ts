// 보행 경로 보조: 문 → 보도 목표점 결정, 건물에 막힌 직선을 돌아가는 최단 경로(부풀린 건물 모서리 가시성 그래프, 최대 6 꺾임).
// graph.ts(문 노드 연결)와 place.ts(뒷줄 건물 접근 검증)가 같은 함수를 쓴다.
import type {P2} from './geom.js';
import type {Obb} from './obb.js';
import {segHitsObb} from './obb.js';
import type {PlaceCtx} from './place-ctx.js';
import {pointAt, sideEdges} from './roads.js';

const INFL = 1.2, CLEAR = 0.6, MAX_NODES = 48;
/** from → to 경로의 중간 점들. 막힘이 없으면 [], 돌아갈 길이 없으면 null. own 박스는 장애물에서 제외 */
export function routeAround(ctx: PlaceCtx, from: P2, to: P2, own: Obb): P2[] | null {
  const mx = (from[0] + to[0]) / 2, mz = (from[1] + to[1]) / 2, R = Math.hypot(from[0] - to[0], from[1] - to[1]) / 2 + 8;
  const bl = ctx.obstacles(mx, mz, R, -1e9, 1e9, ['building']).filter(o => o.obb && !(Math.abs(o.obb.cx - own.cx) < 1e-6 && Math.abs(o.obb.cz - own.cz) < 1e-6)).map(o => o.obb!);
  const free = (a: P2, b: P2) => !bl.some(o => segHitsObb(o, a, b, CLEAR));
  if (free(from, to)) return [];
  const pts: P2[] = [from, to];
  for (const o of bl) {
    const cr = Math.cos(o.rot * Math.PI / 180), sr = Math.sin(o.rot * Math.PI / 180);
    for (const c of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = c[0] * (o.hw + INFL), lz = c[1] * (o.hd + INFL), w: P2 = [o.cx + cr * lx + sr * lz, o.cz - sr * lx + cr * lz];
      if (!bl.some(q => segHitsObb(q, w, w, 0.2))) pts.push(w);
    }
  }
  if (pts.length > MAX_NODES) { const head = pts.slice(0, 2), rest = pts.slice(2).sort((a, b) => Math.hypot(a[0] - mx, a[1] - mz) - Math.hypot(b[0] - mx, b[1] - mz)).slice(0, MAX_NODES - 2); pts.length = 0; pts.push(...head, ...rest); }
  const n = pts.length, dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
  dist[0] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity) break;
    done[u] = true;
    if (u === 1) break;
    for (let v = 0; v < n; v++) {
      if (done[v]) continue;
      const d = dist[u] + Math.hypot(pts[u][0] - pts[v][0], pts[u][1] - pts[v][1]);
      if (d < dist[v] && free(pts[u], pts[v])) { dist[v] = d; prev[v] = u; }
    }
  }
  if (dist[1] === Infinity) return null;
  const out: P2[] = [];
  for (let v = prev[1]; v > 0; v = prev[v]) out.push(pts[v]);
  return out.reverse();
}

export interface DoorTarget { ri: number; side: 'left' | 'right'; s: number; x: number; z: number }
/** 문 바깥 점(from) 근처 가장 가까운 보도 있는 지상 도로 가장자리 → 도로·쪽·s 와 그 s 의 보도 중심 좌표. 없으면 null */
export function doorTarget(ctx: PlaceCtx, x: number, z: number, reach = 90): DoorTarget | null {
  let best: ReturnType<PlaceCtx['hits']>[number] | null = null, bd = Infinity;
  for (const h of ctx.hits(x, z, reach)) { const d = h.dist - h.e5; if (h.layer === 0 && h.e4 - h.e3 >= 1.0 && ctx.roads[h.ri].cls !== 'expressway' && d < bd) { bd = d; best = h; } }
  if (!best) return null;
  const right = best.lat >= 0, p = pointAt(ctx.roads[best.ri], best.s), e = sideEdges(p.sec, 0, right), lat = (e.e3 + e.e4) / 2, c = ctx.at(best.ri, best.s, right ? lat : -lat);
  return {ri: best.ri, side: right ? 'right' : 'left', s: best.s, x: c.x, z: c.z};
}
