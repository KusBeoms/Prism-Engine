// facilities.port → compiled.port: 상판 데크, 진입 도로 높이(도로 지면 → 정문 상판), 물과 맞닿은 외곽 변(울타리), 충돌체.
// 순수·결정적. 지형은 도로 회랑이 반영된 최종 높이(terrainFinal)를 쓴다.
import type {CitySource, PortRect, PortSource} from '../city-schema.js';
import type {CompiledPort, Collider} from '../city-compiled.js';
import {rnd} from './bytes.js';
import {sampleBilinear} from './terrain.js';
import type {Terrain} from './terrain.js';

type Edge = [number, number, number, number];
const EPS = 1e-6;

/** 상판 사각형 합집합의 외곽 변(내부에 묻힌 변은 뺀다). 반환: 축 정렬 선분 [x0,z0,x1,z1] */
export function portEdges(rects: readonly PortRect[]): Edge[] {
  const out: Edge[] = [];
  const sub = (lo: number, hi: number, cut: [number, number][]): [number, number][] => {
    let parts: [number, number][] = [[lo, hi]];
    for (const [a, b] of cut) {
      const next: [number, number][] = [];
      for (const [p, q] of parts) {
        if (b <= p + EPS || a >= q - EPS) { next.push([p, q]); continue; }
        if (a > p + EPS) next.push([p, a]);
        if (b < q - EPS) next.push([b, q]);
      }
      parts = next;
    }
    return parts.filter(([p, q]) => q - p > 0.05);
  };
  for (const r of rects) {
    const others = rects.filter(q => q !== r);
    // 북(z0)·남(z1): 바깥쪽에 다른 상판이 있으면 그 x 구간은 내부
    const north: [number, number][] = [], south: [number, number][] = [], west: [number, number][] = [], east: [number, number][] = [];
    for (const q of others) {
      if (q.z0 < r.z0 - EPS && q.z1 > r.z0 - EPS || (Math.abs(q.z1 - r.z0) < EPS)) { if (q.z0 <= r.z0 + EPS && q.z1 >= r.z0 - EPS) north.push([Math.max(r.x0, q.x0), Math.min(r.x1, q.x1)]); }
      if (q.z0 <= r.z1 + EPS && q.z1 > r.z1 + EPS) south.push([Math.max(r.x0, q.x0), Math.min(r.x1, q.x1)]);
      if (q.x0 <= r.x0 + EPS && q.x1 >= r.x0 - EPS && (q.x0 < r.x0 - EPS || Math.abs(q.x1 - r.x0) < EPS)) west.push([Math.max(r.z0, q.z0), Math.min(r.z1, q.z1)]);
      if (q.x0 <= r.x1 + EPS && q.x1 > r.x1 + EPS) east.push([Math.max(r.z0, q.z0), Math.min(r.z1, q.z1)]);
    }
    for (const [a, b] of sub(r.x0, r.x1, north)) out.push([a, r.z0, b, r.z0]);
    for (const [a, b] of sub(r.x0, r.x1, south)) out.push([a, r.z1, b, r.z1]);
    for (const [a, b] of sub(r.z0, r.z1, west)) out.push([r.x0, a, r.x0, b]);
    for (const [a, b] of sub(r.z0, r.z1, east)) out.push([r.x1, a, r.x1, b]);
  }
  return out;
}

const WALL = 0.35;
const aabb = (owner: string, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): Collider => ({owner, shape: {t: 'aabb', x0: rnd(x0), z0: rnd(z0), x1: rnd(x1), z1: rnd(z1)}, y0: rnd(y0), y1: rnd(y1), required: true});

export function bakePort(src: CitySource, terrain: Terrain): CompiledPort | undefined {
  const port: PortSource | undefined = src.facilities?.port;
  if (!port) return undefined;
  const dy = port.deckY, decks: CompiledPort['decks'] = [], colliders: Collider[] = [];
  // 상판 → 데크 띠(긴 변이 중심선, 짧은 변의 절반이 반폭)
  for (const r of port.platforms) {
    const w = r.x1 - r.x0, d = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    if (w >= d) decks.push({id: `port:${r.id}`, ax: r.x0, az: cz, bx: r.x1, bz: cz, hw: d / 2, h0: dy, h1: dy});
    else decks.push({id: `port:${r.id}`, ax: cx, az: r.z0, bx: cx, bz: r.z1, hw: w / 2, h0: dy, h1: dy});
  }
  // 진입 도로: 첫 점은 도로 지면, 정문(마지막 점)에서 상판 높이. 중간은 거리 비례
  const ap = port.access.pts, cum = [0];
  for (let i = 1; i < ap.length; i++) cum.push(cum[i - 1] + Math.hypot(ap[i][0] - ap[i - 1][0], ap[i][1] - ap[i - 1][1]));
  const y0 = sampleBilinear(terrain, ap[0][0], ap[0][1]), pts: [number, number, number][] = ap.map((p, i) => [p[0], p[1], rnd(y0 + (dy - y0) * (cum[i] / (cum[cum.length - 1] || 1)))]);
  for (let i = 0; i + 1 < pts.length; i++) decks.push({id: `port:access#${i}`, ax: pts[i][0], az: pts[i][1], bx: pts[i + 1][0], bz: pts[i + 1][1], hw: port.access.width / 2, h0: pts[i][2], h1: pts[i + 1][2]});
  // 외곽 변 → 울타리. 정문 개구는 비우고 닫힌 차단기 충돌체로 막는다(보행자는 항상 막힘, 차단기 애니메이션은 차량용 연출)
  const g = port.gate, gap: Edge = [g.x - g.width / 2, g.z, g.x + g.width / 2, g.z];
  const edges: Edge[] = [];
  for (const e of portEdges(port.platforms)) {
    if (Math.abs(e[1] - g.z) < EPS && Math.abs(e[3] - g.z) < EPS && e[0] < gap[2] && e[2] > gap[0]) {
      if (e[0] < gap[0] - EPS) edges.push([e[0], e[1], gap[0], e[3]]);
      if (e[2] > gap[2] + EPS) edges.push([gap[2], e[1], e[2], e[3]]);
    } else edges.push(e);
  }
  const lo = port.baseY, hi = dy + 4;
  edges.forEach((e, i) => colliders.push(aabb(`port:edge:${i}`, Math.min(e[0], e[2]) - WALL, Math.min(e[1], e[3]) - WALL, Math.max(e[0], e[2]) + WALL, Math.max(e[1], e[3]) + WALL, lo, hi)));
  colliders.push(aabb('port:gate', gap[0], g.z - WALL, gap[2], g.z + WALL, lo, hi));
  for (const b of port.buildings) colliders.push(aabb(`port:bld:${b.id}`, b.x0, b.z0, b.x1, b.z1, dy - 0.5, dy + b.h));
  for (const bl of port.yard.blocks) colliders.push(aabb(`port:yard:${bl.id}`, bl.x0, bl.z0, bl.x0 + bl.cols * 12, bl.z0 + bl.rows * 2.4, dy - 0.5, dy + bl.maxTiers * 2.6));
  // 안벽(물가) 길이 = 정문 선(육지 쪽 북변)을 뺀 외곽 변 길이 합
  const quay = edges.filter(e => !(Math.abs(e[1] - e[3]) < EPS && Math.abs(e[1] - g.z) < EPS)).reduce((t, e) => t + Math.hypot(e[2] - e[0], e[3] - e[1]), 0);
  return {
    source: port, decks: decks.map(d => ({...d, ax: rnd(d.ax), az: rnd(d.az), bx: rnd(d.bx), bz: rnd(d.bz), hw: rnd(d.hw), h0: rnd(d.h0), h1: rnd(d.h1)})),
    access: {pts, width: port.access.width}, edges: edges.map(e => e.map(rnd) as Edge), gateGap: gap.map(rnd) as Edge, colliders,
    controlled: port.platforms.map(r => [r.x0, r.z0, r.x1, r.z1] as Edge), quayLength: rnd(quay),
  };
}
