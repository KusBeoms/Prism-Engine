// 배치 단계(필지·건물·소품·녹지·주차·그래프·충돌체) 공용 타입. 순수.
import type {BuildingSource, BuildingStyle, PropKind, PropProfile, ZoneSource} from '../city-schema.js';
import type {Placement} from '../city-compiled.js';
import type {Obb} from './obb.js';

/** 시선 축(사과): 기지 (0,17) 에서 정북 ±8°, 고도 8°. 이 원뿔 위로 올라오는 건물·나무는 거부 */
export interface SightAxis {
  id: string; x: number; z: number; y?: number;
  /** 0 = 정북(-z), 시계 방향(+동) */
  azimuthDeg: number; halfDeg: number; elevDeg: number; eye: number;
}
export const DEFAULT_SIGHT = {azimuthDeg: 0, halfDeg: 8, elevDeg: 8, eye: 1.65} as const;
/** 외부 예약 구간: 버스 정류장 등 소품을 금지할 도로 구간 */
export interface Reserve { road: string; side?: 'left' | 'right' | 'both'; s0: number; s1: number; reason: string }
export interface PlaceOpts {
  sightAxes?: SightAxis[];
  reserve?: Reserve[];
  /** source.props 가 비었을 때 기본 프로필을 쓸지(기본 true) */
  defaultProps?: boolean;
  /** 도시 경계 안쪽 숲 띠 폭(m, 기본 22, 0 이면 끔) */
  edgeBand?: number;
  /** 전체 나무 상한(기본 80000) */
  maxTrees?: number;
  /** 구역 용도별 녹지율 목표 덮어쓰기(0~1) */
  coverage?: Record<string, number>;
  /** 필지 한도 덮어쓰기 */
  maxSlope?: number; maxAlt?: number;
  /** 주차 차량 점유율 0~1 (기본 0.8) */
  occupancy?: number;
  /** true 면 nb-sight* 건축 금지 예외를 그대로 적용(기본: 높이 상한으로 대체) */
  sightNoBuild?: boolean;
}
/** 도로 한쪽에 접한 대지(자동 또는 명시 ParcelSource) */
export interface Lot {
  id: string; zone: string; road: string; ri: number; side: 'left' | 'right';
  t0: number; t1: number; depth: number;
  /** 직사각형 대지: 중심, 도로 방향(전면) 단위벡터 u, 안쪽(도로→대지) 단위벡터 v, 전면 폭 w, 깊이 d */
  cx: number; cz: number; ux: number; uz: number; vx: number; vz: number; w: number; d: number;
  /** 도로 중심선에서 대지 앞 경계까지의 가로 거리 */
  lat0: number;
  style: BuildingStyle; explicit: boolean;
  /** 뒷줄 필지(1)와 접근 통로 쪽(앞줄·뒷줄 공통: 통로가 +u(1) 쪽인가 -u(-1) 쪽인가) */
  /** 0 = 앞줄, k>=1 = k번째 뒷줄(통로 corridor 로 보도에 닿음). rowLast=false 면 그 뒤에 또 줄이 있어 건물을 통로 반대쪽으로 민다 */
  row?: number; corridor?: 1 | -1; rowLast?: boolean;
  /** 건물 문을 낼 도로 방향(전면) 중점 s */
  sMid: number;
}
export interface PadRec { id: string; cx: number; cz: number; hw: number; hd: number; rot: number; y: number }
export type ReqKind = 'lamp' | 'tree' | 'bench' | 'sign' | 'signal' | 'bin' | 'bollard' | 'shrub';
/** 배치된 소품(내부 기록) — compiled 의 Placement 로 내보내기 전 형태 */
export interface PropRec {
  id: string; owner: string; profile: string; kind: ReqKind;
  road: string; ri: number; side: 'left' | 'right' | 'median';
  s: number; lat: number;
  x: number; y: number; z: number; rot: number;
  asset: string; r: number; h: number; scale: number;
  /** 벤치처럼 직사각형 점유 */
  obb?: Obb;
}
export interface PropRej { profile: string; kind: string; road: string; side: string; s: number; code: string; msg: string }
export interface Interval { s0: number; s1: number; reason: string; side: 'left' | 'right' | 'both' }
export interface PlacedBuilding { src: BuildingSource; obb: Obb; top: number; lot: string; zone: string }
export interface ZoneOut {
  zone: ZoneSource; lots: Lot[]; buildings: PlacedBuilding[]; pads: PadRec[];
  parking: import('../city-compiled.js').ParkingSlotOut[];
  trees: Placement[];
  rejected: {owner: string; code: string; msg: string}[];
  lotsTried: number;
}
export type { PropKind, PropProfile };
