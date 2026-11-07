// 그래프 마무리: 도로 기하(겹친 교차로·잘린 팔)로 끊긴 성분을 가장 가까운 노드 쌍으로 잇는다. 원인이 해결된 곳에서는 아무 일도 하지 않는다.
// 보행: 다른 성분 사이의 가장 가까운 쌍(60m 이내)을 Kruskal 방식으로 잇고 3~16m 이면 횡단(crosswalk) 태그. 차량: 나가는 간선이 없는 차로 끝(sink)을 가장 가까운 차로 시작(source)에 이어 방향을 지킨다(층이 다르면 높이차 4m 이내만, 램프 태그).
import type {GraphEdge, GraphNode} from '../city-compiled.js';

export interface StitchIO { nodes: GraphNode[]; edges: GraphEdge[]; link: (a: number, b: number, mode: 'car' | 'ped', directed: boolean, tag?: GraphEdge['tag']) => void }
const uf = (n: number) => { const p = Array.from({length: n}, (_, i) => i); const f = (i: number): number => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; }; return {f, u: (a: number, b: number) => { p[f(a)] = f(b); }}; };
class Grid {
  private m = new Map<string, number[]>();
  constructor(private nodes: GraphNode[], private cell: number) {}
  add(id: number): void { const n = this.nodes[id], k = `${Math.floor(n.x / this.cell)},${Math.floor(n.z / this.cell)}`; const l = this.m.get(k); if (l) l.push(id); else this.m.set(k, [id]); }
  near(x: number, z: number, r: number): number[] {
    const out: number[] = [], c = this.cell, n = Math.ceil(r / c), cx = Math.floor(x / c), cz = Math.floor(z / c);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (const id of this.m.get(`${cx + i},${cz + j}`) ?? []) out.push(id);
    return out;
  }
}
const dist = (a: GraphNode, b: GraphNode): number => Math.hypot(a.x - b.x, a.z - b.z, (a.y - b.y) * 0.5);

/** 보행 그래프의 서로 다른 성분을 maxD(m) 안의 최근접 쌍으로 잇는다. 이은 간선 수를 돌려준다 */
export function stitchPed(io: StitchIO, maxD = 60): number {
  const n = io.nodes.length, u = uf(n), inG = new Uint8Array(n);
  for (const e of io.edges) if (e.mode === 'ped') { u.u(e.a, e.b); inG[e.a] = inG[e.b] = 1; }
  const grid = new Grid(io.nodes, 10), ids: number[] = [];
  for (let i = 0; i < n; i++) if (inG[i] && !io.nodes[i].door) { grid.add(i); ids.push(i); }
  const cand: {d: number; a: number; b: number}[] = [];
  for (const a of ids) {
    const A = io.nodes[a];
    let best = -1, bd = maxD;
    for (const b of grid.near(A.x, A.z, maxD)) { const B = io.nodes[b]; if (B.layer !== A.layer || u.f(a) === u.f(b)) continue; const d = dist(A, B); if (d < bd) { bd = d; best = b; } }
    if (best >= 0) cand.push({d: bd, a, b: best});
  }
  cand.sort((p, q) => p.d - q.d || p.a - q.a);
  let made = 0;
  for (const c of cand) { if (u.f(c.a) === u.f(c.b)) continue; io.link(c.a, c.b, 'ped', false, c.d > 3 && c.d <= 16 ? 'crosswalk' : undefined); u.u(c.a, c.b); made++; }
  return made;
}
/** 차량 그래프: 나가는 간선이 없는 노드(차로 끝)를 다른 성분의, 들어오는 간선이 없는 노드(차로 시작)로 잇는다 */
export function stitchCar(io: StitchIO, maxD = 30): number {
  const n = io.nodes.length, u = uf(n), inG = new Uint8Array(n), outd = new Int32Array(n), ind = new Int32Array(n);
  for (const e of io.edges) if (e.mode === 'car') { u.u(e.a, e.b); inG[e.a] = inG[e.b] = 1; outd[e.a]++; ind[e.b]++; if (!e.oneWay) { outd[e.b]++; ind[e.a]++; } }
  const grid = new Grid(io.nodes, 10), sinks: number[] = [];
  for (let i = 0; i < n; i++) { if (!inG[i]) continue; if (ind[i] === 0) grid.add(i); if (outd[i] === 0) sinks.push(i); }
  let made = 0;
  for (const s of sinks) {
    const A = io.nodes[s];
    let best = -1, bd = maxD;
    for (const t of grid.near(A.x, A.z, maxD)) { const B = io.nodes[t]; if ((B.layer !== A.layer && Math.abs(A.y - B.y) > 4) || u.f(s) === u.f(t)) continue; const d = dist(A, B); if (d < bd) { bd = d; best = t; } }
    if (best >= 0) { io.link(s, best, 'car', true); u.u(s, best); made++; }
  }
  return made;
}
