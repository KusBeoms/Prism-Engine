// city.compiled.json 윤곽(타입만). 빌더(citygen)가 city.source.json 에서 만들고 게임은 이것만 읽는다.
// 렌더·보행·충돌이 좌표를 다시 추측하지 않도록 표본/리본/배치/충돌체/그래프를 한 번에 담는다. 순수 타입이며 값 import 는 없다.
import type {PortSource, BuildingSource, CurveKind, Layer, Pt, RoadClass, SegKind} from './city-schema.js';

export const CITY_COMPILED_VERSION = 1;

/** 도로 중심선 표본: 전역 누적거리 s(m)를 청크가 나뉘어도 이어서 쓴다 */
export interface RoadSample {
  s: number;
  x: number; y: number; z: number;
  /** 접선 방향각(rad, atan2(dx, dz)) */
  yaw: number;
  /** 좌우 반폭(m) — 단면 전이 반영 */
  hwL: number; hwR: number;
  /** 종단 경사(비율) */
  grade: number;
}
export interface CompiledRoad {
  id: string;
  cls: RoadClass;
  curve: CurveKind;
  length: number;
  samples: RoadSample[];
  /** 구간 경계: 표본 인덱스 */
  segments: {id: string; i0: number; i1: number; layer: Layer; kind: SegKind}[];
}
/** 공간 청크별 리본 메시 출력(전체 단일 Mesh 금지) */
export interface RibbonChunk {
  /** 청크 키 "cx,cz" (청크 크기는 header.chunkSize) */
  key: string;
  layer: Layer;
  /** surface: 차도/보도/중앙선/횡단보도/연석 등 재질 슬롯 */
  surface: 'asphalt' | 'sidewalk' | 'curb' | 'marking' | 'crosswalk' | 'median' | 'shoulder' | 'deck';
  /** 정점/인덱스 배열은 평탄화한 숫자 열(xyz, 인덱스) */
  positions: number[];
  indices: number[];
  /** 텍스처 투영용 누적거리 기반 v 좌표(선택) */
  uv?: number[];
}
/** 에셋 배치(인스턴싱 대상). 재질/지오메트리는 asset ID 로만 참조 */
export interface Placement {
  id: string;
  asset: string;
  kind: 'lamp' | 'tree' | 'bench' | 'sign' | 'signal' | 'bin' | 'bollard' | 'building' | 'shrub' | 'other';
  x: number; y: number; z: number;
  rot: number;
  scale?: number;
  /** 소유 ID(건물/도로/구역): 충돌·재빌드 시 owner 단위로 교체 */
  owner: string;
}
export type ColliderShape =
  | {t: 'aabb'; x0: number; z0: number; x1: number; z1: number}
  | {t: 'obb'; cx: number; cz: number; hw: number; hd: number; rotDeg: number}
  | {t: 'circle'; cx: number; cz: number; r: number};
export interface Collider {
  /** ownerId 단위 등록/교체/해제(core/terrain.ts 계약) */
  owner: string;
  shape: ColliderShape;
  /** 높이 범위(층 구분) */
  y0: number; y1: number;
  /** 필수 충돌 종류(줄기/기둥/울타리/벤치/표지판/구조물) 여부 */
  required: boolean;
}
/** 길찾기 노드는 (x,z,layer)로 구분하고 y 를 함께 가진다 */
export interface GraphNode { id: number; x: number; y: number; z: number; layer: Layer; /** [추가·선택] 건물 출입문 노드면 건물 id (차수 1 허용) */ door?: string }
export interface GraphEdge {
  a: number; b: number;
  mode: 'car' | 'ped';
  len: number;
  oneWay?: boolean;
  /** 램프/횡단보도 등 특수 간선 */
  tag?: 'ramp' | 'crosswalk' | 'stairs';
}
export interface CompiledGraph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface ParkingSlotOut {
  id: string;
  x: number; y: number; z: number; rot: number;
  kind: 'perpendicular' | 'parallel' | 'angled';
  layer: Layer;
  vehicleId?: string;
}
export interface TerrainCompiled {
  /** 도로·패드를 반영한 최종 높이 래스터(cm, 행 우선 delta-b64) */
  cell: number; x0: number; z0: number; cols: number; rows: number;
  heightData: string;
  /** 경사/표면 분류 마스크(1바이트/칸, base64) */
  surfaceMask?: string;
}
export interface CompiledHeader {
  compiledVersion: number;
  /** 입력 원본의 버전 3종과 해시 — 불일치하면 다시 빌드해야 한다 */
  schemaVersion: number;
  cityRevision: number;
  generatorVersion: number;
  seed: number;
  sourceHash: string;
  chunkSize: number;
}
/** [추가·선택] 교차로 요약: 신호/그래프/횡단보도 배치가 같은 노드를 쓰도록 citygen 이 채운다 (ribbons 에는 이미 메시로 구워져 있다) */
export interface CompiledJunction {
  id: string;
  kind: string;
  layer: Layer;
  x: number; y: number; z: number;
  /** 포장 외곽선 */
  polygon: Pt[];
  /** 연결 팔: 도로 ID, dir(+1/-1 = 도로 s 증가/감소 쪽으로 노드에서 멀어짐), 노드의 도로 s, 트림 거리(m) */
  arms: {road: string; dir: 1 | -1; s: number; trim: number}[];
  /** 회전교차로 중앙섬 */
  island?: {x: number; z: number; r: number};
  crosswalks: number;
  stopLines: number;
}
/** [추가·선택] 필지 요약: 대지 사각형(중심, 전면 방향 u, 폭 w, 깊이 d)과 소속 */
export interface CompiledParcel { id: string; zone: string; road: string; side: 'left' | 'right'; x: number; z: number; w: number; d: number; rot: number; building: boolean }
export interface CityCompiled {
  header: CompiledHeader;
  bounds: Pt[];
  terrain: TerrainCompiled;
  roads: CompiledRoad[];
  ribbons: RibbonChunk[];
  placements: Placement[];
  colliders: Collider[];
  graph: CompiledGraph;
  parking: ParkingSlotOut[];
  /** [추가·선택] citygen 도로 단계가 채운다 */
  junctions?: CompiledJunction[];
  /** [추가·선택] citygen 배치 단계가 채운다: 자동+명시 건물 원본(렌더가 id 로 찾는다)과 필지 요약 */
  buildings?: BuildingSource[];
  parcels?: CompiledParcel[];
  /** [추가·선택] 물류 항구를 구운 결과(citygen/port-bake.ts). 원본 facilities.port 가 있을 때만 */
  port?: CompiledPort;
  /** 빌더가 배치하지 못한 항목과 사유(에디터 표시용) */
  rejected: {owner: string; code: string; msg: string}[];
}

/** 항구 굽기 결과: 원본 항구 + 상판 데크·진입 도로 높이·울타리 구간·충돌체(compiled.colliders 에도 같은 owner 로 들어간다) */
export interface CompiledPort {
  source: PortSource;
  /** 걸을 수 있는 상판/램프 띠(core/deck.ts 입력과 같은 모양) */
  decks: {id: string; ax: number; az: number; bx: number; bz: number; hw: number; h0: number; h1: number}[];
  /** 진입 도로 중심선 [x, z, y] (진입 끝은 도로 지면에 이어지고 정문에서 상판 높이가 된다) */
  access: {pts: [number, number, number][]; width: number};
  /** 상판 외곽 중 물과 맞닿은 변(울타리·난간). [x0,z0,x1,z1] */
  edges: [number, number, number, number][];
  /** 정문 개구 */
  gateGap: [number, number, number, number];
  colliders: Collider[];
  /** 통제 구역(상판 합집합) 경계 사각형들 */
  controlled: [number, number, number, number][];
  /** 안벽 총 길이(m) = 선박이 붙을 수 있는 물가 변의 합 */
  quayLength: number;
}
