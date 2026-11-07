// 에디터 검증: 게임·빌더와 같은 validateCitySource + 에디터 전용 순수 검사(끝점 미접속, 짧은 도로, 경계 밖 끝점, 같은 모양 중복).
import {validateCitySource} from '../city-validate.js';
import type {CitySource, Pt} from '../city-schema.js';
import {nearest, roadLength} from './roadops.js';
import type {Issue} from './state.js';
import {runExtra} from './checks2.js';

/** 끝점이 다른 도로·노드에 닿았다고 보는 거리(m) */
export const TOUCH_M = 2;
const MIN_ROAD_M = 10;

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** 'roads[3].pts[2]' 같은 경로에서 도로와 점 위치를 찾는다 */
function locate(doc: CitySource, path: string): {road?: string; at?: Pt} {
  const m = /^roads\[(\d+)\](?:\.pts\[(\d+)\])?/.exec(path);
  if (m) {
    const r = doc.roads?.[+m[1]];
    const at = r && m[2] !== undefined ? r.pts?.[+m[2]] : r?.pts?.[0];
    return {road: r?.id, at: Array.isArray(at) ? (at as Pt) : undefined};
  }
  const z = /^(zones|anchors|nodes)\[(\d+)\]/.exec(path);
  if (z) {
    const o: any = (doc as any)[z[1]]?.[+z[2]];
    if (z[1] === 'zones' && Array.isArray(o?.poly?.[0])) return {at: o.poly[0] as Pt};
    if (z[1] === 'anchors' && typeof o?.x === 'number') return {at: [o.x, o.z]};
    if (z[1] === 'nodes' && Array.isArray(o?.at)) return {at: o.at};
  }
  return {};
}

export function runChecks(doc: CitySource): Issue[] {
  const out: Issue[] = [];
  const v = validateCitySource(doc);
  for (const e of v.errors) out.push({sev: 'error', code: e.code, msg: `${e.path}: ${e.msg}`, path: e.path, ...locate(doc, e.path)});
  const roads = Array.isArray(doc.roads) ? doc.roads.filter(r => r && Array.isArray(r.pts) && r.pts.length >= 2 && r.pts.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) : [];
  const nodeAt: Pt[] = Array.isArray(doc.nodes) ? doc.nodes.filter(n => Array.isArray(n?.at)).map(n => n.at) : [];
  const seen = new Map<string, string>();
  for (const r of roads) {
    const first = r.pts[0], last = r.pts[r.pts.length - 1];
    const len = roadLength(r);
    if (len < MIN_ROAD_M) out.push({sev: 'warn', code: 'short-road', msg: `${r.id}: 길이 ${len.toFixed(1)}m — 너무 짧은 도로`, road: r.id, at: first});
    const key = JSON.stringify(r.pts), rev = JSON.stringify([...r.pts].reverse());
    const dup = seen.get(key) ?? seen.get(rev);
    if (dup) out.push({sev: 'warn', code: 'duplicate-shape', msg: `${r.id}: ${dup} 와 점 배열이 같음`, road: r.id, at: first});
    seen.set(key, r.id);
    if (Array.isArray(doc.bounds) && doc.bounds.length >= 3) {
      for (const [p, nm] of [[first, '시작'], [last, '끝']] as [Pt, string][]) {
        if (!pointInPoly(p, doc.bounds)) out.push({sev: 'warn', code: 'end-outside-bounds', msg: `${r.id}: ${nm}점이 건축 가능 경계 밖`, road: r.id, at: p});
      }
    }
    for (const [p, nm] of [[first, '시작'], [last, '끝']] as [Pt, string][]) {
      if (nodeAt.some(a => Math.hypot(a[0] - p[0], a[1] - p[1]) <= TOUCH_M)) continue;
      let touch = false;
      for (const o of roads) {
        if (o === r) continue;
        if (nearest(o, p[0], p[1]).d <= TOUCH_M) { touch = true; break; }
      }
      // 같은 도로의 반대쪽 끝에 닿는 고리(순환 도로)도 접속으로 본다
      if (!touch && Math.hypot(first[0] - last[0], first[1] - last[1]) <= TOUCH_M) touch = true;
      if (!touch) out.push({sev: 'warn', code: 'dangling-end', msg: `${r.id}: ${nm}점이 어떤 도로·노드에도 닿지 않음 (${p[0]}, ${p[1]})`, road: r.id, at: p});
    }
  }
  out.push(...runExtra(doc));
  return out;
}
