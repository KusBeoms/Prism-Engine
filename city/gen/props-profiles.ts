// 소품 프로필 기본값(source.props 가 비었을 때 쓴다)과 단면에서 가로 위치를 구하는 함수.
// 'stagger' 의 spacing 은 양쪽을 번갈아 놓은 "합친 열"의 간격이다(한쪽만 보면 2배). 그 밖의 side 는 한쪽 열의 간격이다.
// band: 소품이 서는 가로 띠 — plant(식재대 가운데) / walk(보도 가운데) / curb(연석에서 offset) / median(중앙분리대 위, 돌출형만).
import type {PropProfile, RoadClass} from '../city-schema.js';
import {SEC, sideEdges} from './roads.js';

export interface PropRule extends PropProfile {
  band?: 'plant' | 'walk' | 'curb' | 'median';
  species?: string[];
  /** 같은 종류가 겹칠 때 낮은 숫자 먼저 */
  prio?: number;
}
export const PRIO: Record<string, number> = {signal: 0, sign: 0, lamp: 1, tree: 2, bench: 3, bin: 4, bollard: 5};

const P = (id: string, kind: PropProfile['kind'], roadClass: RoadClass, side: PropProfile['side'], min: number, target: number, max: number, band: PropRule['band'], clearance: number, offset = 0): PropRule =>
  ({id, kind, roadClass, side, spacing: {min, target, max}, offset, clearance, band});
/** 등급별 기본 프로필: 가로등·가로수·벤치·휴지통·볼라드 (신호기·표지판은 교차로에서 따로 만든다) */
export const DEFAULT_PROPS: readonly PropRule[] = [
  P('lamp.expressway', 'lamp', 'expressway', 'median', 30, 40, 50, 'median', 4),
  P('lamp.arterial1', 'lamp', 'arterial1', 'median', 28, 35, 42, 'median', 3),
  P('lamp.arterial2', 'lamp', 'arterial2', 'stagger', 22, 30, 36, 'plant', 3),
  P('lamp.collector', 'lamp', 'collector', 'stagger', 20, 26, 32, 'plant', 3),
  P('lamp.local', 'lamp', 'local', 'stagger', 20, 28, 36, 'plant', 3),
  {...P('tree.arterial1', 'tree', 'arterial1', 'both', 9, 12, 16, 'plant', 4), species: ['round', 'round', 'pine']},
  {...P('tree.arterial2', 'tree', 'arterial2', 'both', 8, 10, 14, 'plant', 4), species: ['round', 'round', 'pine']},
  {...P('tree.collector', 'tree', 'collector', 'both', 7, 9, 12, 'plant', 3.5), species: ['round', 'round', 'pine']},
  {...P('tree.local', 'tree', 'local', 'both', 6, 8, 11, 'plant', 3), species: ['round', 'round', 'pine']},
  P('bench.arterial1', 'bench', 'arterial1', 'both', 40, 60, 90, 'plant', 4),
  P('bench.arterial2', 'bench', 'arterial2', 'both', 40, 55, 80, 'plant', 4),
  P('bench.collector', 'bench', 'collector', 'stagger', 50, 70, 100, 'plant', 4),
  P('bin.arterial1', 'bin', 'arterial1', 'both', 50, 70, 100, 'plant', 3),
  P('bin.arterial2', 'bin', 'arterial2', 'both', 50, 70, 100, 'plant', 3),
  P('bollard.arterial1', 'bollard', 'arterial1', 'both', 6, 8, 12, 'curb', 2, 0.55),
  P('bollard.arterial2', 'bollard', 'arterial2', 'both', 6, 8, 12, 'curb', 2, 0.55),
];

/** 소품(반경 rad)이 서는 가로 위치 lat(양수 = 도로 오른쪽 기준 바깥 거리, 중앙분리대는 0). 들어갈 공간이 없으면 null */
export function latFor(rule: PropRule, sec: ArrayLike<number>, right: boolean, rad: number): number | null {
  if (rule.band === 'median') return sec[SEC.oneWay] < 0.5 && sec[SEC.med] >= 1.0 && sec[SEC.med] / 2 >= rad + 0.15 ? 0 : null;
  const e = sideEdges(sec, 0, right);
  switch (rule.band) {
    case 'plant': { const w = e.e5 - e.e4; return w >= 2 * rad + 0.2 ? e.e4 + w / 2 : null; }
    case 'walk': { const w = e.e4 - e.e3; return w >= 2 * rad + 1.2 ? e.e3 + w / 2 : null; }
    case 'curb': { const w = e.e4 - e.e3; return w >= rule.offset + rad + 1.4 ? e.e3 + Math.max(rule.offset, 0.5) : null; }
    default: { const l = e.e3 + rule.offset; return l + rad <= e.e5 && e.e5 > e.e3 ? l : null; }
  }
}
