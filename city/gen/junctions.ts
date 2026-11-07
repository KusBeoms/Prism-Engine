// 교차로 노드 검출. 입력: 해석된 도로들 + NodeSource + RampSource. 같은 층(layer)끼리만 합친다. 층 변화는 RampSource 로만.
// 후보: ① 같은 층 중심선 교차 ② 도로 끝이 다른 도로 옆면(2m 이내)에 닿는 T/엘보 ③ 끝-끝 접촉 ④ NodeSource(도로 목록 + 램프 도로).
// 후보를 반경 안에서 합쳐 군집(노드)으로 만든다. 군집마다 도로별 s 와 팔(arm: 노드에서 멀어지는 방향)을 정한다.
import type {NodeKind, NodeSource, RampSource} from '../city-schema.js';
import {SpatialHash, segIntersect} from './geom.js';
import type {P2} from './geom.js';
import {KIND_CODE, SEC, nearestOnRoad, pointAt, sideEdges} from './roads.js';
import type {Rej, RoadGeo} from './roads.js';

export const CLUSTER_R = 3.0;       // 자동 후보 합치기 반경(m)
export const NODE_MERGE_R = 8.0;    // 자동 후보를 NodeSource 에 붙이는 반경
export const NODE_ROAD_R = 12.0;    // NodeSource 가 도로를 찾는 반경
export const END_SNAP = 2.0;        // 도로 끝이 옆면에 닿았다고 보는 거리

export interface Arm {
  ri: number; roadId: string;
  /** 1 = 도로 +s 쪽으로 노드에서 멀어짐, -1 = -s 쪽 */
  dir: 1 | -1;
  sNode: number;
  ox: number; oy: number; oz: number;
  ux: number; uz: number; angle: number;
  /** u 의 오른쪽 법선 p=(-uz,ux) 쪽 / 반대쪽 포장 반폭(e3), 보도 폭 */
  wP: number; wM: number; walkP: number; walkM: number;
  /** 반대쪽(-p) 차로 가장자리 e0~e1 — 진입 차로 범위(우측통행, 정지선용) */
  lM0: number; lM1: number;
  oneWay: boolean;
  cls: RoadGeo['cls'];
  layer: number;
  /** 확정 트림 거리(노드 기준 팔 방향 m) */
  trim: number;
}
export interface Cluster {
  id: string; kind: NodeKind | 'cross'; layer: number; x: number; z: number; y: number;
  nodeId?: string;
  members: {ri: number; s: number}[];
  arms: Arm[];
}

interface Cand { layer: number; x: number; z: number; members: {ri: number; s: number}[]; nodeIdx: number }

const layerAt = (r: RoadGeo, i: number): number => r.segs[r.segIdx[i]].layer;
const isRamp = (r: RoadGeo, i: number): boolean => KIND_CODE[r.segs[r.segIdx[i]].kind] === 3;

export function detectClusters(roads: RoadGeo[], nodes: NodeSource[], ramps: RampSource[], warn: Rej[]): Cluster[] {
  const cands: Cand[] = [];
  const byId = new Map<string, number>();
  roads.forEach((r, i) => byId.set(r.id, i));
  const hash = new SpatialHash<number>(32);
  const segRef: [number, number][] = [];
  roads.forEach((r, ri) => {
    for (let i = 0; i + 1 < r.n; i++) {
      segRef.push([ri, i]);
      hash.insert(r.x[i], r.z[i], r.x[i + 1], r.z[i + 1], segRef.length - 1);
    }
  });
  // ① 교차 + ② 끝-옆면
  const seen = new Set<string>();
  roads.forEach((a, ai) => {
    for (let i = 0; i + 1 < a.n; i++) {
      const la = layerAt(a, i);
      if (isRamp(a, i)) continue;
      const pa: P2 = [a.x[i], a.z[i]], pb: P2 = [a.x[i + 1], a.z[i + 1]];
      for (const k of new Set(hash.query(Math.min(pa[0], pb[0]) - 0.1, Math.min(pa[1], pb[1]) - 0.1, Math.max(pa[0], pb[0]) + 0.1, Math.max(pa[1], pb[1]) + 0.1))) {
        const [bi, j] = segRef[k];
        if (bi <= ai) continue;
        const b = roads[bi];
        if (layerAt(b, j) !== la || isRamp(b, j)) continue;
        const key = `${ai},${i},${bi},${j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const h = segIntersect(pa, pb, [b.x[j], b.z[j]], [b.x[j + 1], b.z[j + 1]], 1e-6);
        if (!h) continue;
        cands.push({layer: la, x: h.x, z: h.z, nodeIdx: -1, members: [{ri: ai, s: a.s[i] + h.t * (a.s[i + 1] - a.s[i])}, {ri: bi, s: b.s[j] + h.u * (b.s[j + 1] - b.s[j])}]});
      }
    }
    // 끝점이 다른 도로에 닿는 경우 (옆면 2m 이내)
    for (const end of [0, a.n - 1]) {
      const ea = end === 0 ? 0 : a.n - 2;
      if (isRamp(a, ea)) continue;
      const la = layerAt(a, ea), best = new Map<number, {d: number; s: number; x: number; z: number}>();
      for (const k of new Set(hash.query(a.x[end] - END_SNAP, a.z[end] - END_SNAP, a.x[end] + END_SNAP, a.z[end] + END_SNAP))) {
        const [bi, j] = segRef[k];
        if (bi === ai) continue;
        const b = roads[bi];
        if (layerAt(b, j) !== la || isRamp(b, j)) continue;
        const dx = b.x[j + 1] - b.x[j], dz = b.z[j + 1] - b.z[j], l2 = dx * dx + dz * dz;
        const f = l2 > 1e-12 ? Math.min(1, Math.max(0, ((a.x[end] - b.x[j]) * dx + (a.z[end] - b.z[j]) * dz) / l2)) : 0;
        const fx = b.x[j] + dx * f, fz = b.z[j] + dz * f, d = Math.hypot(a.x[end] - fx, a.z[end] - fz);
        const cur = best.get(bi);
        if (d <= END_SNAP && (!cur || d < cur.d)) best.set(bi, {d, s: b.s[j] + f * (b.s[j + 1] - b.s[j]), x: fx, z: fz});
      }
      for (const [bi, v] of [...best.entries()].sort((p, q) => p[0] - q[0])) cands.push({layer: la, x: v.x, z: v.z, nodeIdx: -1, members: [{ri: ai, s: a.s[end]}, {ri: bi, s: v.s}]});
    }
  });
  // ④ NodeSource
  const rampRoads = new Map<string, string[]>();
  for (const rp of ramps) for (const nid of [rp.fromNode, rp.toNode]) { const l = rampRoads.get(nid) ?? []; l.push(rp.road); rampRoads.set(nid, l); }
  nodes.forEach((nd, ni) => {
    const list = [...new Set([...nd.roads, ...(rampRoads.get(nd.id) ?? [])])];
    const members: {ri: number; s: number}[] = [];
    for (const rid of list) {
      const ri = byId.get(rid);
      if (ri === undefined) { warn.push({owner: nd.id, code: 'node-road-missing', msg: `노드가 가리키는 도로 ${rid} 가 없거나 거부되었다`}); continue; }
      const r = roads[ri], nr = nearestOnRoad(r, nd.at[0], nd.at[1]);
      if (nr.dist > NODE_ROAD_R) { warn.push({owner: nd.id, code: 'node-road-far', msg: `도로 ${rid} 가 노드에서 ${nr.dist.toFixed(1)}m 떨어져 있어 제외했다`}); continue; }
      const p = pointAt(r, nr.s), ramp = KIND_CODE[r.segs[p.seg].kind] === 3;
      if (!ramp && r.segs[p.seg].layer !== nd.layer) { warn.push({owner: nd.id, code: 'node-layer-mismatch', msg: `도로 ${rid} 는 이 위치에서 층 ${r.segs[p.seg].layer} 인데 노드는 층 ${nd.layer} — 합치지 않는다`}); continue; }
      members.push({ri, s: nr.s});
    }
    if (members.length) cands.push({layer: nd.layer, x: nd.at[0], z: nd.at[1], members, nodeIdx: ni});
  });
  return mergeCands(cands, roads, nodes);
}

function mergeCands(cands: Cand[], roads: RoadGeo[], nodes: NodeSource[]): Cluster[] {
  const n = cands.length, par = cands.map((_, i) => i);
  const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const sorted = cands.map((c, i) => i).sort((a, b) => cands[a].layer - cands[b].layer || cands[a].x - cands[b].x || cands[a].z - cands[b].z);
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const ca = cands[sorted[a]], cb = cands[sorted[b]];
    if (cb.layer !== ca.layer) break;
    if (cb.x - ca.x > NODE_MERGE_R) break;
    const d = Math.hypot(ca.x - cb.x, ca.z - cb.z);
    const lim = ca.nodeIdx >= 0 || cb.nodeIdx >= 0 ? NODE_MERGE_R : CLUSTER_R;
    if (d <= lim && !(ca.nodeIdx >= 0 && cb.nodeIdx >= 0 && ca.nodeIdx !== cb.nodeIdx)) par[find(sorted[a])] = find(sorted[b]);
  }
  const groups = new Map<number, Cand[]>();
  for (let i = 0; i < n; i++) { const g = find(i); const l = groups.get(g); if (l) l.push(cands[i]); else groups.set(g, [cands[i]]); }
  const out: Cluster[] = [];
  for (const g of groups.values()) {
    const node = g.find(c => c.nodeIdx >= 0), nd = node ? nodes[node.nodeIdx] : undefined;
    const cx = nd ? nd.at[0] : g.reduce((s, c) => s + c.x, 0) / g.length, cz = nd ? nd.at[1] : g.reduce((s, c) => s + c.z, 0) / g.length;
    const best = new Map<number, {s: number; d: number}>();
    for (const c of g) for (const m of c.members) {
      const r = roads[m.ri], p = pointAt(r, m.s), d = Math.hypot(p.x - cx, p.z - cz), cur = best.get(m.ri);
      if (!cur || d < cur.d) best.set(m.ri, {s: m.s, d});
    }
    const members = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([ri, v]) => ({ri, s: v.s}));
    if (members.length === 0 || (members.length === 1 && !nd)) continue;
    out.push({id: nd ? nd.id : '', kind: nd ? nd.kind : 'cross', layer: g[0].layer, x: cx, z: cz, y: nd?.y ?? 0, nodeId: nd?.id, members, arms: []});
  }
  out.sort((a, b) => a.layer - b.layer || a.x - b.x || a.z - b.z);
  let auto = 0;
  for (const c of out) if (!c.id) c.id = `auto${auto++}@${c.layer}`;
  return out;
}

/** 군집의 팔을 만든다. 도로 양 끝에서 0.5m 안이면 한쪽 팔만. 방향은 노드에서 8m 떨어진 점으로 잰 현 */
export function buildArms(c: Cluster, roads: RoadGeo[]): void {
  c.arms = [];
  let sy = 0;
  for (const m of c.members) {
    const r = roads[m.ri], p0 = pointAt(r, m.s);
    sy += p0.y;
    for (const dir of [1, -1] as const) {
      if (dir === 1 && m.s > r.length - 0.5) continue;
      if (dir === -1 && m.s < 0.5) continue;
      const q = pointAt(r, m.s + dir * Math.min(8, dir === 1 ? r.length - m.s : m.s));
      let ux = q.x - p0.x, uz = q.z - p0.z;
      const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
      const sec = p0.sec, rightIsP = dir === 1; // dir=1 이면 u=접선, p=nR(u)=도로 오른쪽
      const eP = sideEdges(sec, 0, rightIsP), eM = sideEdges(sec, 0, !rightIsP);
      c.arms.push({ri: m.ri, roadId: r.id, dir, sNode: m.s, ox: p0.x, oy: p0.y, oz: p0.z, ux, uz, angle: Math.atan2(uz, ux), wP: eP.e3, wM: eM.e3, walkP: sec[SEC.walk], walkM: sec[SEC.walk], lM0: eM.e0, lM1: eM.e1, oneWay: sec[SEC.oneWay] > 0.5,
        cls: r.cls, layer: r.segs[p0.seg].layer, trim: 0});
    }
  }
  c.y = c.members.length ? sy / c.members.length : c.y;
  c.arms.sort((a, b) => a.angle - b.angle || a.ri - b.ri);
}
