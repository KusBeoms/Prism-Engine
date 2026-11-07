// 자동 교차로(순수, DOM 없음): 도로 끝점 접촉·선분 교차를 찾아 nodes 에 `jx-N` 교차로 노드를 만들고 갱신·정리한다.
// - 이번 편집에서 바뀐(새로 생기거나 점·곡선·등급·구간이 달라진) 도로가 낀 접촉만 계산하고, 편집 전부터 닿아 있던 접촉(에디터 노드가 없던 곳)은 건너뛴다.
//   그래서 생성기가 만든 기존 교차를 한 번 옮겼다고 신호등 노드로 도배하지 않는다.
// - 에디터가 만든 노드만 관리한다(id 가 `jx-` 로 시작). 생성기·사람이 만든 노드(endpoint/rampEnd/bridgeEnd/junction…)는 지우지 않는다.
// - 층(layer)이 다르거나 어느 한쪽 구간이 ground 가 아닌(bridge/tunnel/ramp) 곳은 입체교차로 보고 교차로로 만들지 않는다.
import {segIntersect, sampleControlPath, type Dense} from '../gen/geom.js';
import {LIMITS, type CitySource, type NodeSource, type Pt, type RoadSource} from '../city-schema.js';
import {dropNode, zeroCounts} from './refs.js';

/** 끝점이 다른 도로 옆면에 닿았다고 보는 거리(m) — 빌더(junctions.ts)의 2m 와 같다 */
export const TOUCH_M = 2;
/** 같은 교차로로 합치는 접촉점 간 거리(m) */
export const MERGE_M = 3;
export const JX_PREFIX = 'jx-';
const SIGNAL_CLASSES = new Set(['expressway', 'arterial1', 'arterial2']);
export const isJx = (n: NodeSource) => n.id.startsWith(JX_PREFIX);

export interface JxResult { added: number; updated: number; removed: number }
interface Pre { d: Dense; bb: [number, number, number, number]; key: string; r: RoadSource }
interface Contact { x: number; z: number; layer: number; ids: Set<string> }

const keyOf = (r: RoadSource) => JSON.stringify([r.pts, r.curve, r.cls, (r.segments ?? []).map(s => [s.from, s.to, s.layer, s.kind])]);
/** 기준선: 마지막 동기화(또는 불러오기·되돌리기) 시점의 도로 모양. 편집 전부터 있던 접촉과 새 접촉을 구분하는 데 쓴다 */
let baseline = new Map<string, {key: string; road: RoadSource}>();
const dcache = new Map<string, {key: string; d: Dense}>();
export function rebaseline(doc: CitySource | null) {
  const old = baseline;
  baseline = new Map((doc?.roads ?? []).map(r => { const key = keyOf(r), o = old.get(r.id); return [r.id, o && o.key === key ? o : {key, road: JSON.parse(JSON.stringify(r)) as RoadSource}]; }));
}
function pre(r: RoadSource, tag = ''): Pre {
  const key = keyOf(r), ck = tag + r.id;
  let c = dcache.get(ck);
  if (!c || c.key !== key) { c = {key, d: sampleControlPath(r.pts, r.pts.length < 3 ? 'line' : r.curve, 0.5, 2, LIMITS.samplesPerRoad)}; dcache.set(ck, c); }
  const d = c.d;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < d.n; i++) { x0 = Math.min(x0, d.x[i]); x1 = Math.max(x1, d.x[i]); z0 = Math.min(z0, d.z[i]); z1 = Math.max(z1, d.z[i]); }
  return {d, bb: [x0 - TOUCH_M, z0 - TOUCH_M, x1 + TOUCH_M, z1 + TOUCH_M], key, r};
}
/** 표본 j 에서의 (층, 종류). 구간 정의가 없으면 지상 */
function surfaceAt(p: Pre, j: number): {layer: number; kind: string} {
  const segs = p.r.segments;
  if (!segs?.length) return {layer: 0, kind: 'ground'};
  const ctrl = p.d.ctrl;
  let i = 0;
  while (i < ctrl.length - 2 && ctrl[i + 1] <= j) i++;
  const s = segs.find(q => q.from <= i && q.to >= i + 1);
  return s ? {layer: s.layer, kind: s.kind} : {layer: 0, kind: 'ground'};
}
const flat = (a: {layer: number; kind: string}, b: {layer: number; kind: string}) => a.layer === b.layer && a.kind === 'ground' && b.kind === 'ground';

function distToPoly(d: Dense, x: number, z: number): {dist: number; j: number} {
  let best = Infinity, bj = 0;
  for (let j = 1; j < d.n; j++) {
    const ax = d.x[j - 1], az = d.z[j - 1], bx = d.x[j] - ax, bz = d.z[j] - az, l2 = bx * bx + bz * bz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / l2)) : 0;
    const dist = Math.hypot(x - (ax + bx * t), z - (az + bz * t));
    if (dist < best) { best = dist; bj = t > 0.5 ? j : j - 1; }
  }
  return {dist: best, j: bj};
}
const overlap = (a: Pre, b: Pre) => !(a.bb[2] < b.bb[0] || b.bb[2] < a.bb[0] || a.bb[3] < b.bb[1] || b.bb[3] < a.bb[1]);

/** A(바뀐 도로)와 B 사이의 접촉점들 */
function contactsOf(a: Pre, b: Pre, out: Contact[]) {
  const ids = () => new Set([a.r.id, b.r.id]);
  // ① 선분 교차 (끝점 접촉 포함)
  for (let i = 1; i < a.d.n; i++) {
    const ax = a.d.x[i - 1], az = a.d.z[i - 1], bx = a.d.x[i], bz = a.d.z[i];
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), z0 = Math.min(az, bz), z1 = Math.max(az, bz);
    if (x1 < b.bb[0] || x0 > b.bb[2] || z1 < b.bb[1] || z0 > b.bb[3]) continue;
    for (let j = 1; j < b.d.n; j++) {
      const cx = b.d.x[j - 1], cz = b.d.z[j - 1], dx = b.d.x[j], dz = b.d.z[j];
      if (Math.max(cx, dx) < x0 || Math.min(cx, dx) > x1 || Math.max(cz, dz) < z0 || Math.min(cz, dz) > z1) continue;
      const h = segIntersect([ax, az], [bx, bz], [cx, cz], [dx, dz]);
      if (h && flat(surfaceAt(a, i - 1), surfaceAt(b, j - 1))) out.push({x: h.x, z: h.z, layer: 0, ids: ids()});
    }
  }
  // ② 한쪽 끝점이 다른 도로 옆면에 닿음
  const ends = (p: Pre, q: Pre) => {
    for (const j of [0, p.d.n - 1]) {
      const x = p.d.x[j], z = p.d.z[j];
      if (x < q.bb[0] || x > q.bb[2] || z < q.bb[1] || z > q.bb[3]) continue;
      const h = distToPoly(q.d, x, z);
      if (h.dist <= TOUCH_M && flat(surfaceAt(p, j), surfaceAt(q, h.j))) out.push({x, z, layer: 0, ids: ids()});
    }
  };
  ends(a, b); ends(b, a);
}
function layerOfContact(c: Contact, pres: Map<string, Pre>): number {
  for (const id of c.ids) { const p = pres.get(id); if (p) { const j = distToPoly(p.d, c.x, c.z).j; return surfaceAt(p, j).layer; } }
  return 0;
}
const r1 = (v: number) => Math.round(v * 10) / 10;
function freshId(doc: CitySource): string {
  const used = new Set(doc.nodes.map(n => n.id));
  for (let i = 1; ; i++) if (!used.has(`${JX_PREFIX}${i}`)) return `${JX_PREFIX}${i}`;
}

/** 편집 뒤에 호출한다. 반환: 바뀐 개수. opts.all = 모든 도로를 새로 계산(수동 재생성) */
export function syncJunctions(doc: CitySource, opts: {all?: boolean} = {}): JxResult {
  const res: JxResult = {added: 0, updated: 0, removed: 0};
  const live = new Map(doc.roads.map(r => [r.id, r]));
  const changed = new Set<string>();
  for (const r of doc.roads) if (opts.all || baseline.get(r.id)?.key !== keyOf(r)) changed.add(r.id);
  const removedRoads = [...baseline.keys()].filter(id => !live.has(id));
  const nodes = doc.nodes;
  const roadsOnly = (n: NodeSource) => n.roads.filter(id => live.has(id) && !changed.has(id));
  // A. 바뀌거나 사라진 도로를 에디터 노드에서 뗀다
  const managed = nodes.filter(n => isJx(n) && n.roads.some(id => changed.has(id) || !live.has(id))).map(n => ({at: n.at, roads: n.roads}));
  const before = new Map(nodes.filter(isJx).map(n => [n.id, JSON.stringify([n.at, [...n.roads].sort(), n.kind])]));
  for (const n of nodes) if (isJx(n)) n.roads = roadsOnly(n);
  // B. 바뀐 도로의 접촉점
  const pres = new Map<string, Pre>();
  const get = (id: string) => { let p = pres.get(id); if (!p) { p = pre(live.get(id)!); pres.set(id, p); } return p; };
  const contacts: Contact[] = [];
  for (const id of changed) {
    const a = get(id);
    for (const r of doc.roads) { if (r.id === id || (changed.has(r.id) && r.id < id)) continue; const b = get(r.id); if (overlap(a, b)) contactsOf(a, b, contacts); }
  }
  for (const c of contacts) c.layer = layerOfContact(c, pres);
  // 편집 전 모양으로 같은 접촉을 구해 둔다: 원래부터 닿아 있던 곳(에디터가 관리하지 않던 곳)에는 노드를 새로 만들지 않는다
  const oldPres = new Map<string, Pre>(), oldOf = (id: string) => { let p = oldPres.get(id); if (!p) { const b = baseline.get(id); p = changed.has(id) && b ? pre(b.road, 'old:') : get(id); oldPres.set(id, p); } return p; };
  const oldContacts: Contact[] = [];
  for (const id of changed) {
    if (!baseline.has(id)) continue;
    const a = oldOf(id);
    for (const r of doc.roads) { if (r.id === id || (changed.has(r.id) && r.id < id)) continue; const b = oldOf(r.id); if (overlap(a, b)) contactsOf(a, b, oldContacts); }
  }
  for (const c of oldContacts) c.layer = 0;
  const wasThere = (c: Contact) => oldContacts.some(o => [...o.ids].every(id => c.ids.has(id)) && Math.hypot(o.x - c.x, o.z - c.z) <= MERGE_M + 1);
  // C. 접촉점 군집화 (같은 층, MERGE_M 이내)
  const par = contacts.map((_, i) => i);
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < contacts.length; i++) for (let j = i + 1; j < contacts.length; j++) {
    if (contacts[i].layer === contacts[j].layer && Math.hypot(contacts[i].x - contacts[j].x, contacts[i].z - contacts[j].z) <= MERGE_M) par[find(j)] = find(i);
  }
  const groups = new Map<number, Contact[]>();
  contacts.forEach((c, i) => { const g = find(i); (groups.get(g) ?? groups.set(g, []).get(g)!).push(c); });
  for (const g of groups.values()) {
    const roads = [...new Set(g.flatMap(c => [...c.ids]))].filter(id => live.has(id));
    if (roads.length < 2 || roads.length > 32) continue;
    const at0: Pt = [g.reduce((q, c) => q + c.x, 0) / g.length, g.reduce((q, c) => q + c.z, 0) / g.length];
    if (g.every(wasThere) && !managed.some(m => Math.hypot(m.at[0] - at0[0], m.at[1] - at0[1]) <= MERGE_M * 2 && m.roads.some(id => roads.includes(id)))) continue;
    const at: Pt = [r1(g.reduce((s, c) => s + c.x, 0) / g.length), r1(g.reduce((s, c) => s + c.z, 0) / g.length)], layer = g[0].layer;
    const kind = roads.filter(id => SIGNAL_CLASSES.has(live.get(id)!.cls)).length >= 2 ? 'signal' : 'junction';
    // 같은 자리의 기존 노드: 에디터 노드면 합치고, 그 외 junction/signal 이면 도로만 보태며, 나머지 종류는 그대로 둔다
    const near = nodes.filter(n => n.layer === layer && Math.hypot(n.at[0] - at[0], n.at[1] - at[1]) <= TOUCH_M + 1).sort((p, q) => Math.hypot(p.at[0] - at[0], p.at[1] - at[1]) - Math.hypot(q.at[0] - at[0], q.at[1] - at[1]));
    const host = near.find(isJx) ?? near.find(n => n.kind === 'junction' || n.kind === 'signal');
    if (host) { if (isJx(host)) host.at = at; host.roads = [...new Set([...host.roads, ...roads])].slice(0, 32); continue; }
    if (near.length) continue;
    if (nodes.length >= LIMITS.nodes) continue;
    nodes.push({id: freshId(doc), kind, at, layer, roads});
  }
  // D. 도로가 2개 미만이 된 에디터 노드 정리
  const c0 = zeroCounts();
  for (const n of [...nodes]) if (isJx(n) && n.roads.length < 2) dropNode(doc, n.id, c0);
  // 결과 집계
  const after = new Map(nodes.filter(isJx).map(n => [n.id, JSON.stringify([n.at, [...n.roads].sort(), n.kind])]));
  for (const [id, v] of after) { if (!before.has(id)) res.added++; else if (before.get(id) !== v) res.updated++; }
  for (const id of before.keys()) if (!after.has(id)) res.removed++;
  void removedRoads;
  rebaseline(doc);
  return res;
}
export const summarizeJx = (r: JxResult) => (r.added || r.updated || r.removed ? `자동 교차로: +${r.added} ~${r.updated} -${r.removed}` : '');
