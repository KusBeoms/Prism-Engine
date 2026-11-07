// 길찾기 그래프. 보행: 보도 중심선 + 교차로 모서리 띠 + 횡단(표시 횡단보도는 트림 밖 2m, 그 밖은 팔 입구) + 건물 문 노드.
// 차량: 방향별 차로 축(오른쪽 통행) 위 방향 간선(oneWay=true), 교차로 안은 진입→진출 회전 간선(U턴 금지, noTurn 은 직진만), 회전교차로는 반시계 링.
// 노드 키는 (x,z,layer) 이고 y 를 가진다. 층이 다른 노드를 잇는 간선은 항상 tag 'ramp' (고가 교차 지점에 가짜 간선 없음).
import type {CompiledGraph, GraphEdge, GraphNode} from '../city-compiled.js';
import type {Obb} from './obb.js';
import {routeAround} from './route.js';
import {stitchCar, stitchPed} from './graph-stitch.js';
import type {PlaceCtx} from './place-ctx.js';
import {pointAt, sideEdges} from './roads.js';
import type {Rej} from './roads.js';

export interface DoorRef { id: string; x: number; z: number; ri: number; side: 'left' | 'right'; s: number; own: Obb }
export interface GraphStats { stitchedPed: number; stitchedCar: number; pedComponents: number; carComponents: number; pedMinDeg: number; pedLowDeg: number; doorNodes: number; doorUnreachable: number; nodes: number; edges: number }
const SNAP = 0.35, STEP_PED = 10, STEP_CAR = 12, CROSS_OFF = 2.0, WALK_MIN = 1.0;

class G {
  nodes: GraphNode[] = []; edges: GraphEdge[] = [];
  private cell = new Map<string, number[]>();
  /** 같은 층·같은 문 표지의 기존 노드가 SNAP(m) 안에 있으면 재사용한다(서로 다른 계산 경로의 반올림 차이로 노드가 갈라지는 것을 막는다) */
  node(x: number, y: number, z: number, layer: number, door?: string): number {
    const cx = Math.floor(x / 0.5), cz = Math.floor(z / 0.5);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const id of this.cell.get(`${cx + i},${cz + j},${layer}`) ?? []) {
        const n = this.nodes[id];
        if (Math.abs(n.x - x) < SNAP && Math.abs(n.z - z) < SNAP && (n.door ?? '') === (door ?? '')) return id;
      }
    }
    const id = this.nodes.length;
    this.nodes.push({id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100, layer, ...(door ? {door} : {})});
    const k = `${cx},${cz},${layer}`;
    const l = this.cell.get(k); if (l) l.push(id); else this.cell.set(k, [id]);
    return id;
  }
  link(a: number, b: number, mode: 'car' | 'ped', directed: boolean, tag?: GraphEdge['tag']): void {
    if (a === b) return;
    const A = this.nodes[a], B = this.nodes[b], len = Math.round(Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z) * 100) / 100;
    const t = tag ?? (A.layer !== B.layer ? 'ramp' : undefined);
    this.edges.push({a, b, mode, len, ...(directed ? {oneWay: true} : {}), ...(t ? {tag: t} : {})});
  }
}
interface Cut { t0: number; t1: number }
function cutsOf(ctx: PlaceCtx, ri: number): Cut[] {
  const iv = (ctx.arms.get(ri) ?? []).map(a => ({t0: a.dir === 1 ? a.sNode : a.sNode - a.trim, t1: a.dir === 1 ? a.sNode + a.trim : a.sNode})).sort((a, b) => a.t0 - b.t0);
  const out: Cut[] = [];
  for (const v of iv) { const l = out[out.length - 1]; if (l && v.t0 <= l.t1 + 1e-6) l.t1 = Math.max(l.t1, v.t1); else out.push({...v}); }
  return out;
}
function pieces(ctx: PlaceCtx, ri: number): [number, number][] {
  const L = ctx.roads[ri].length, out: [number, number][] = [], cs = cutsOf(ctx, ri);
  let cur = 0;
  for (const c of cs) { if (c.t0 - cur > 0.5) out.push([cur, c.t0]); cur = Math.max(cur, c.t1); }
  if (L - cur > 0.5) out.push([cur, L]);
  return out;
}
/** 구간 [a,b] 의 표본 s: 양 끝 + 필수(extras) + 격자(필수와 2.5m 이상 떨어진 것) */
function sList(a: number, b: number, step: number, extras: number[]): number[] {
  const must = [a, b, ...extras.filter(s => s > a + 0.3 && s < b - 0.3)].sort((p, q) => p - q);
  const out = must.slice();
  const n = Math.max(1, Math.round((b - a) / step));
  for (let i = 1; i < n; i++) { const s = a + ((b - a) * i) / n; if (must.every(m => Math.abs(m - s) > 2.5)) out.push(s); }
  return out.sort((p, q) => p - q);
}
const uf = (n: number) => { const p = Array.from({length: n}, (_, i) => i); const f = (i: number): number => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; }; return {f, u: (a: number, b: number) => { p[f(a)] = f(b); }}; };

export function buildGraph(ctx: PlaceCtx, doors: DoorRef[]): {graph: CompiledGraph; stats: GraphStats; rej: Rej[]} {
  const g = new G(), rej: Rej[] = [], ped = new Map<string, number>(), lane = new Map<string, number>(), pedSide = new Map<string, number[]>();
  const K = (ri: number, c: string, s: number) => `${ri}|${c}|${s.toFixed(3)}`;
  const segLayer = (ri: number, s: number): number => { const r = ctx.roads[ri]; return r.segs[pointAt(r, s).seg].layer; };
  const pl = new Map<string, {s: number; id: number}[]>(), ll = new Map<string, {s: number; id: number}[]>();
  const pedList = (ri: number, c: string) => pl.get(`${ri}${c}`) ?? pl.set(`${ri}${c}`, []).get(`${ri}${c}`)!;
  const laneList = (ri: number, d: string) => ll.get(`${ri}${d}`) ?? ll.set(`${ri}${d}`, []).get(`${ri}${d}`)!;
  const nearest = (l: {s: number; id: number}[] | undefined, s: number, tol: number): number | undefined => { let b: number | undefined, bd = tol; for (const q of l ?? []) { const d = Math.abs(q.s - s); if (d <= bd) { bd = d; b = q.id; } } return b; };
  /** 정확한 s 의 노드, 없으면(합쳐진 교차로 절단 안쪽 등) 같은 도로·쪽에서 tol(m) 안의 가장 가까운 노드 */
  const pedAt = (ri: number, c: string, s: number, tol = 12): number | undefined => ped.get(K(ri, c, s)) ?? nearest(pl.get(`${ri}${c}`), s, tol);
  const laneAt = (ri: number, d: string, s: number, tol = 12): number | undefined => lane.get(K(ri, d, s)) ?? nearest(ll.get(`${ri}${d}`), s, tol);
  const doorS = new Map<string, number[]>();
  for (const d of doors) { const k = `${d.ri}|${d.side}`; (doorS.get(k) ?? doorS.set(k, []).get(k)!).push(d.s); }

  // ── 보행: 보도 ──
  ctx.roads.forEach((r, ri) => {
    if (r.cls === 'expressway') return;
    const arms = ctx.arms.get(ri) ?? [], pcs = pieces(ctx, ri);
    const xs = arms.filter(a => a.crosswalk).map(a => a.sNode + a.dir * (a.trim + CROSS_OFF));
    for (const side of ['left', 'right'] as const) {
      const right = side === 'right', c = right ? 'R' : 'L', extras = [...xs, ...(doorS.get(`${ri}|${side}`) ?? [])];
      for (const [a, b] of pcs) {
        let prev = -1;
        for (const s of sList(a, b, STEP_PED, extras)) {
          const p = pointAt(r, s), e = sideEdges(p.sec, 0, right), seg = r.segs[p.seg];
          if (e.e4 - e.e3 < WALK_MIN) { prev = -1; continue; }
          const lat = (e.e3 + e.e4) / 2, ls = right ? lat : -lat, id = g.node(p.x - p.tz * ls, p.y + 0.15, p.z + p.tx * ls, seg.layer);
          ped.set(K(ri, c, s), id); pedList(ri, c).push({s, id});
          (pedSide.get(`${ri}|${side}`) ?? pedSide.set(`${ri}|${side}`, []).get(`${ri}|${side}`)!).push(id);
          if (prev >= 0) g.link(prev, id, 'ped', false);
          prev = id;
        }
      }
    }
    // 열린 도로 끝: 좌우 보도를 이어 막다른 길 방지
    const L0 = cutsOf(ctx, ri);
    for (const s of [0, r.length]) {
      if (L0.some(c => s >= c.t0 - 1e-6 && s <= c.t1 + 1e-6)) continue;
      const a = ped.get(K(ri, 'L', s)), b = ped.get(K(ri, 'R', s));
      if (a !== undefined && b !== undefined) g.link(a, b, 'ped', false);
    }
  });
  // ── 보행: 팔 입구 노드 보장 + 합쳐진 교차로 사이 틈 잇기 + 횡단(표시 횡단보도는 트림+2m, 그 밖은 팔 입구) ──
  const pedNode = (ri: number, side: 'left' | 'right', s: number): number | undefined => {
    const r = ctx.roads[ri], right = side === 'right', c = right ? 'R' : 'L', ex = ped.get(K(ri, c, s));
    if (ex !== undefined) return ex;
    const p = pointAt(r, s), e = sideEdges(p.sec, 0, right);
    if (e.e4 - e.e3 < WALK_MIN) return undefined;
    const lat = (e.e3 + e.e4) / 2, ls = right ? lat : -lat, id = g.node(p.x - p.tz * ls, p.y + 0.15, p.z + p.tx * ls, r.segs[p.seg].layer);
    ped.set(K(ri, c, s), id); pedList(ri, c).push({s, id}); (pedSide.get(`${ri}|${side}`) ?? pedSide.set(`${ri}|${side}`, []).get(`${ri}|${side}`)!).push(id);
    return id;
  };
  const clampS = (ri: number, s: number) => Math.min(ctx.roads[ri].length, Math.max(0, s));
  ctx.roads.forEach((r, ri) => {
    if (r.cls === 'expressway') return;
    const ports = (ctx.arms.get(ri) ?? []).map(a => ({a, s: clampS(ri, a.sNode + a.dir * a.trim)})).sort((x, y) => x.s - y.s);
    for (const side of ['left', 'right'] as const) {
      for (const q of ports) pedNode(ri, side, q.s);
      for (let i = 0; i + 1 < ports.length; i++) {
        const x = ports[i], y = ports[i + 1];
        if (x.a.dir !== 1 || y.a.dir !== -1 || x.a.j === y.a.j) continue;
        const lst = pl.get(`${ri}${side === 'right' ? 'R' : 'L'}`) ?? [];
        if (lst.some(n => n.s > x.s + 0.05 && n.s < y.s - 0.05)) continue;
        const nx = pedNode(ri, side, x.s), ny = pedNode(ri, side, y.s);
        if (nx !== undefined && ny !== undefined) g.link(nx, ny, 'ped', false);
      }
    }
    for (const a of ctx.arms.get(ri) ?? []) {
      const s = clampS(ri, a.crosswalk ? a.sNode + a.dir * (a.trim + CROSS_OFF) : a.sNode + a.dir * a.trim), l = pedNode(ri, 'left', s), rr = pedNode(ri, 'right', s);
      if (l !== undefined && rr !== undefined) g.link(l, rr, 'ped', false, 'crosswalk');
    }
  });
  // ── 보행: 교차로 모서리 + 통과 교차로 ──
  ctx.juncs.forEach(j => {
    const ends: number[] = [];
    for (const a of j.arms) {
      const ri = ctx.byId.get(a.roadId);
      if (ri === undefined) continue;
      const s = a.sNode + a.dir * a.trim;
      for (const c of ['L', 'R']) { const id = pedAt(ri, c, s); if (id !== undefined) ends.push(id); }
    }
    if (j.passThrough) {
      const byRoad = new Map<string, number[]>();
      for (const a of j.arms) (byRoad.get(a.roadId) ?? byRoad.set(a.roadId, []).get(a.roadId)!).push(a.sNode + a.dir * a.trim);
      for (const [rid, ss] of byRoad) { const ri = ctx.byId.get(rid)!; if (ss.length === 2) for (const c of ['L', 'R']) { const p = ped.get(K(ri, c, ss[0])), q = ped.get(K(ri, c, ss[1])); if (p !== undefined && q !== undefined) g.link(p, q, 'ped', false); } }
    }
    for (const b of j.bands) {
      const mid = b.inner.map((v, i) => [(v[0] + b.outer[i][0]) / 2, v[1] + 0.15, (v[2] + b.outer[i][2]) / 2] as [number, number, number]);
      if (mid.length < 2) continue;
      let prev = -1;
      mid.forEach((m, i) => {
        const id = g.node(m[0], m[1], m[2], j.layer);
        if (prev >= 0) g.link(prev, id, 'ped', false);
        prev = id;
        if (i === 0 || i === mid.length - 1) {
          let best = -1, bd = 4.5;
          for (const e of ends) { const n = g.nodes[e], d = Math.hypot(n.x - m[0], n.z - m[2]); if (d < bd) { bd = d; best = e; } }
          if (best >= 0) g.link(id, best, 'ped', false);
        }
      });
    }
  });

  // ── 차량: 차로 축 ──
  const laneLat = (p: ReturnType<typeof pointAt>, right: boolean): number => { const e = sideEdges(p.sec, 0, right); return p.sec[8] > 0.5 ? 0 : (e.e0 + e.e1) / 2; };
  ctx.roads.forEach((r, ri) => {
    const one = r.segs.some(s => s.oneWay), pcs = pieces(ctx, ri);
    for (const [a, b] of pcs) {
      for (const dir of one ? ['f'] : ['f', 'b']) {
        const ss = sList(a, b, STEP_CAR, []);
        const order = dir === 'f' ? ss : ss.slice().reverse();
        let prev = -1;
        for (const s of order) {
          const p = pointAt(r, s), oneP = p.sec[8] > 0.5, right = dir === 'f', lat = oneP ? 0 : laneLat(p, right), ls = right ? lat : -lat;
          const id = g.node(p.x - p.tz * ls, p.y, p.z + p.tx * ls, r.segs[p.seg].layer);
          lane.set(K(ri, dir, s), id); laneList(ri, dir).push({s, id});
          if (prev >= 0) g.link(prev, id, 'car', true);
          prev = id;
        }
      }
    }
    if (!one) for (const s of [0, r.length]) { // 막다른 끝의 유턴
      if (cutsOf(ctx, ri).some(c => s >= c.t0 - 1e-6 && s <= c.t1 + 1e-6)) continue;
      const f = lane.get(K(ri, 'f', s)), b = lane.get(K(ri, 'b', s));
      if (f !== undefined && b !== undefined) { if (s === 0) g.link(b, f, 'car', true); else g.link(f, b, 'car', true); }
    }
  });
  // ── 차량: 팔 입구 노드 보장 + 합쳐진 교차로 사이 틈(조각이 없는 구간)을 차로로 잇기 ──
  const laneNode = (ri: number, dir: 'f' | 'b', s: number): number => {
    const r = ctx.roads[ri], ex = lane.get(K(ri, dir, s));
    if (ex !== undefined) return ex;
    const p = pointAt(r, s), oneP = p.sec[8] > 0.5, right = dir === 'f', lat = oneP ? 0 : laneLat(p, right), ls = right ? lat : -lat;
    const id = g.node(p.x - p.tz * ls, p.y, p.z + p.tx * ls, r.segs[p.seg].layer);
    lane.set(K(ri, dir, s), id); laneList(ri, dir).push({s, id});
    return id;
  };
  ctx.roads.forEach((r, ri) => {
    const one = r.segs.some(s => s.oneWay), dirs: ('f' | 'b')[] = one ? ['f'] : ['f', 'b'];
    const ports = (ctx.arms.get(ri) ?? []).map(a => ({a, s: clampS(ri, a.sNode + a.dir * a.trim)})).sort((x, y) => x.s - y.s);
    for (const q of ports) for (const d of dirs) laneNode(ri, d, q.s);
    for (let i = 0; i + 1 < ports.length; i++) {
      const x = ports[i], y = ports[i + 1];
      if (x.a.dir !== 1 || y.a.dir !== -1 || x.a.j === y.a.j) continue;
      for (const d of dirs) {
        if ((ll.get(`${ri}${d}`) ?? []).some(n => n.s > x.s + 0.05 && n.s < y.s - 0.05)) continue;
        const nx = laneNode(ri, d, x.s), ny = laneNode(ri, d, y.s);
        if (d === 'f') g.link(nx, ny, 'car', true); else g.link(ny, nx, 'car', true);
      }
    }
  });
  ctx.juncs.forEach(j => {
    type Port = {inn?: number; out?: number; ux: number; uz: number; ri: number; ang: number};
    const ports: Port[] = [];
    for (const a of j.arms) {
      const ri = ctx.byId.get(a.roadId);
      if (ri === undefined) continue;
      const r = ctx.roads[ri], s = a.sNode + a.dir * a.trim, one = r.segs.some(x => x.oneWay);
      const q = pointAt(r, Math.min(r.length, Math.max(0, a.sNode + a.dir * 8))), p0 = pointAt(r, a.sNode);
      let ux = q.x - p0.x, uz = q.z - p0.z; const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
      const fwd = laneAt(ri, 'f', s), bwd = laneAt(ri, 'b', s);
      // dir=1 팔: 노드에서 +s 로 멀어짐 → 진입 = 후방(b, -s 이동), 진출 = 전방(f). dir=-1 팔은 반대
      const port: Port = a.dir === 1 ? {inn: bwd, out: fwd, ux, uz, ri, ang: Math.atan2(-uz, ux)} : {inn: fwd, out: bwd, ux, uz, ri, ang: Math.atan2(-uz, ux)};
      if (one && a.dir === 1) port.inn = undefined;
      if (one && a.dir === -1) port.out = undefined;
      ports.push(port);
    }
    if (j.kind === 'roundabout' && j.island && ports.length >= 2) {
      const R = j.island.r + 3.75, ring = ports.map((p, i) => ({p, i})).sort((a, b) => a.p.ang - b.p.ang).map(({p}) => ({p, id: g.node(j.x + Math.cos(p.ang) * R, j.y, j.z - Math.sin(p.ang) * R, j.layer)}));
      ring.forEach((c, k) => {
        g.link(c.id, ring[(k + 1) % ring.length].id, 'car', true);
        if (c.p.inn !== undefined) g.link(c.p.inn, c.id, 'car', true);
        if (c.p.out !== undefined) g.link(c.id, c.p.out, 'car', true);
      });
      return;
    }
    // 막다른 끝(팔 하나): 같은 팔의 진입 → 진출 유턴을 허용해 두 방향 차로가 이어진다
    if (ports.length === 1 && ports[0].inn !== undefined && ports[0].out !== undefined) g.link(ports[0].inn, ports[0].out, 'car', true);
    for (const i of ports) for (const o of ports) {
      if (i === o || i.inn === undefined || o.out === undefined) continue;
      const cos = -(i.ux * o.ux + i.uz * o.uz);
      const road = ctx.roads[i.ri];
      if (road.src.segments?.some(s => s.noTurn?.includes(j.id)) && cos < 0.82) continue;
      g.link(i.inn, o.out, 'car', true);
    }
  });

  // ── 끊긴 성분 잇기(겹친 교차로 등 기하 원인) ──
  const stitchedPed = stitchPed({nodes: g.nodes, edges: g.edges, link: (a, b, m, d, t) => g.link(a, b, m, d, t)}), stitchedCar = stitchCar({nodes: g.nodes, edges: g.edges, link: (a, b, m, d, t) => g.link(a, b, m, d, t)});

  // ── 문 노드 ──
  let doorNodes = 0, unreach = 0;
  for (const d of doors) {
    // 문 앞 보도 노드: 같은 s 의 노드, 없으면 같은 도로·쪽에서 가장 가까운 보도 노드(교차로 팔 근처 문 포함)
    let sw = ped.get(K(d.ri, d.side === 'right' ? 'R' : 'L', d.s)) ?? -1;
    if (sw < 0) { let bd = Infinity; for (const id of pedSide.get(`${d.ri}|${d.side}`) ?? []) { const q = g.nodes[id], dd = Math.hypot(q.x - d.x, q.z - d.z); if (dd < bd) { bd = dd; sw = id; } } }
    if (sw < 0) { rej.push({owner: d.id, code: 'door-unreachable', msg: '문 앞 보도 노드가 없다(보도 없는 도로)'}); unreach++; continue; }
    const t = g.nodes[sw], rt = routeAround(ctx, [d.x, d.z], [t.x, t.z], d.own);
    if (rt === null) { rej.push({owner: d.id, code: 'door-unreachable', msg: '문에서 보도까지 건물에 막혀 돌아갈 길이 없다'}); unreach++; continue; }
    const dn = g.node(d.x, ctx.groundY(d.x, d.z), d.z, 0, d.id);
    let prev = dn;
    for (const w of rt) { const id = g.node(w[0], ctx.groundY(w[0], w[1]), w[1], 0); g.link(prev, id, 'ped', false); prev = id; }
    g.link(prev, sw, 'ped', false);
    doorNodes++;
  }

  // ── 통계 ──
  const n = g.nodes.length, pu = uf(n), cu = uf(n), deg = new Array<number>(n).fill(0), inPed = new Uint8Array(n), inCar = new Uint8Array(n);
  for (const e of g.edges) {
    if (e.mode === 'ped') { pu.u(e.a, e.b); deg[e.a]++; deg[e.b]++; inPed[e.a] = inPed[e.b] = 1; } else { cu.u(e.a, e.b); inCar[e.a] = inCar[e.b] = 1; }
  }
  const comp = (mark: Uint8Array, f: (i: number) => number) => { const s = new Set<number>(); for (let i = 0; i < n; i++) if (mark[i]) s.add(f(i)); return s.size; };
  let minDeg = Infinity, low = 0;
  for (let i = 0; i < n; i++) if (inPed[i] && !g.nodes[i].door) { minDeg = Math.min(minDeg, deg[i]); if (deg[i] < 2) low++; }
  const stats: GraphStats = {stitchedPed, stitchedCar, pedComponents: comp(inPed, pu.f), carComponents: comp(inCar, cu.f), pedMinDeg: minDeg === Infinity ? 0 : minDeg, pedLowDeg: low, doorNodes, doorUnreachable: unreach, nodes: n, edges: g.edges.length};
  return {graph: {nodes: g.nodes, edges: g.edges}, stats, rej};
}
