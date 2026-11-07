// city.source.json 스키마 (순수 타입 + 상수). 도시·높이·월드 모듈을 import 하지 않는다.
// 단위: 거리·폭·높이 m(=u, 1u=1m), 각도 도(°), 좌표 x(동+)·z(남+)·y(위+). 설계: docs/design/CITY_REDESIGN_PLAN.md 10-2/12-1/13절, docs/tech/SCALE.md.
// 편집 대상은 "원본(source)" 뿐이며, 가로등·가로수 같은 반복 소품 좌표는 원본에 쓰지 않는다(빌더가 생성).

/** 지원하는 스키마 형식 버전. 형식이 깨질 때만 올린다 */
export const CITY_SCHEMA_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];
/** 배포되는 원본/빌드 결과 파일의 상대 경로(문서 base 기준) */
export const CITY_SOURCE_PATH = 'data/city.source.json';
export const CITY_COMPILED_PATH = 'data/city.compiled.json';

/** [x, z] 평면 좌표 */
export type Pt = [number, number];
/** 층/표면 ID. 0 = 지상, 1+ = 고가, -1- = 지하. 같은 (x,z)라도 layer가 다르면 다른 노드 */
export type Layer = number;

// ───────── 열거 ─────────
export const ROAD_CLASSES = ['expressway', 'arterial1', 'arterial2', 'collector', 'local'] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];
export const SEG_KINDS = ['ground', 'bridge', 'tunnel', 'ramp'] as const;
export type SegKind = (typeof SEG_KINDS)[number];
/** line = 꺾은선, catmull = centripetal Catmull-Rom(제어점 통과) */
export const CURVE_KINDS = ['line', 'catmull'] as const;
export type CurveKind = (typeof CURVE_KINDS)[number];
export const NODE_KINDS = ['junction', 'signal', 'roundabout', 'endpoint', 'bridgeEnd', 'rampEnd'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const ZONE_USES = ['residential', 'commercial', 'office', 'industrial', 'civic', 'park', 'nature', 'farm', 'water'] as const;
export type ZoneUse = (typeof ZONE_USES)[number];
export const BUILDING_STYLES = ['house', 'shop', 'apartment', 'office', 'highrise', 'civic', 'barn', 'lodge', 'landmark'] as const;
export type BuildingStyle = (typeof BUILDING_STYLES)[number];
export const ANCHOR_KINDS = ['spawn', 'base', 'portal', 'bridgeEnd', 'mountainRoadStart', 'landmark', 'stadium', 'sign'] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];
export const PARKING_KINDS = ['perpendicular', 'parallel', 'angled'] as const;
export type ParkingKind = (typeof PARKING_KINDS)[number];
export const PROP_KINDS = ['lamp', 'tree', 'bench', 'sign', 'signal', 'bin', 'bollard'] as const;
export type PropKind = (typeof PROP_KINDS)[number];
export const PROP_SIDES = ['both', 'left', 'right', 'stagger', 'median'] as const;
export type PropSide = (typeof PROP_SIDES)[number];
export const GREEN_KINDS = ['streetTree', 'lawn', 'forest', 'shrub', 'planter'] as const;
export type GreenKind = (typeof GREEN_KINDS)[number];

// ───────── 상수: 축척(SCALE.md 2절) ─────────
export const SCALE = {
  playerHeight: 1.75, eyeHeight: 1.65, playerRadius: 0.3,
  floorH: {house: 3.0, apartment: 3.0, shop: 4.2, office: 3.8, highrise: 3.8, civic: 3.8, barn: 3.0, lodge: 3.0, landmark: 3.8},
  ceilingMin: 2.4, floorSlab: 0.3, wallThick: 0.3,
  door: {w: 1.0, h: 2.1, wMin: 0.9, wMax: 2.0, hMin: 2.0, hMax: 2.4},
  corridor: 1.2, stair: {w: 1.1, rise: 0.17, run: 0.28, headroom: 2.2},
  car: {sedanLen: 4.7, sedanWid: 1.85, sedanHgt: 1.45, busLen: 11, busWid: 2.55, busHgt: 3.2, clearance: 4.5},
  parking: {perp: {w: 2.5, d: 5.0}, parallel: {w: 2.3, d: 6.0}, angled: {w: 2.6, d: 5.0}},
  curbH: 0.15, crosswalkW: 3.0,
} as const;

/** 도로 등급 기본 단면(한쪽 기준, SCALE.md 2-4절). 구간(segment)의 lanes 덮어쓰기로 바꿀 수 있다 */
export interface RoadProfile {
  lanes: number; laneW: number; median: number;
  parkL: number; parkR: number; walk: number; plant: number; shoulder: number;
  /** 최대 종단 경사(비율, 0.08 = 8%) */
  maxGrade: number; pedAllowed: boolean;
}
export const ROAD_CLASS_DEFAULTS: Readonly<Record<RoadClass, RoadProfile>> = {
  expressway: {lanes: 3, laneW: 3.5, median: 3.0, parkL: 0, parkR: 0, walk: 0, plant: 0, shoulder: 2.5, maxGrade: 0.06, pedAllowed: false},
  arterial1: {lanes: 3, laneW: 3.25, median: 2.0, parkL: 0, parkR: 0, walk: 3.5, plant: 2.0, shoulder: 0, maxGrade: 0.08, pedAllowed: true},
  arterial2: {lanes: 2, laneW: 3.25, median: 0.6, parkL: 0, parkR: 0, walk: 3.0, plant: 1.5, shoulder: 0, maxGrade: 0.08, pedAllowed: true},
  collector: {lanes: 1, laneW: 3.0, median: 0, parkL: 2.3, parkR: 2.3, walk: 2.5, plant: 1.2, shoulder: 0, maxGrade: 0.08, pedAllowed: true},
  local: {lanes: 1, laneW: 2.75, median: 0, parkL: 0, parkR: 2.0, walk: 2.0, plant: 1.0, shoulder: 0, maxGrade: 0.1, pedAllowed: true},
};
/** 등급 기본 단면의 총 폭(m). 구간 덮어쓰기가 없을 때의 값 */
export function roadWidth(p: RoadProfile): number {
  return 2 * p.lanes * p.laneW + p.median + p.parkL + p.parkR + 2 * (p.walk + p.plant + p.shoulder);
}

// ───────── 상수: 상한·범위·기본값 ─────────
export const LIMITS = {
  roads: 600, roadPts: 400, segmentsPerRoad: 40, heightPtsPerSeg: 64, nodes: 2000, ramps: 200, zones: 400, zonePts: 200,
  boundsPts: 400, parcels: 20000, buildings: 6000, anchors: 400, parking: 20000, greenery: 200, propProfiles: 200,
  exceptions: 4000, terrainEdits: 2000, strokePts: 500, floors: 60, id: 64, seedMax: 0x7fffffff,
  /** 곡선 표본 오차(m)와 도로당 최대 표본 수. 게임과 에디터가 공유 */
  curveMaxErr: 0.1, samplesPerRoad: 20000, sampleStep: 1.0,
} as const;
export const RANGES = {
  coord: 20000, height: 400, roadWidth: 80, rot: 360, buildingSide: [3, 150], propSpacing: [1, 200],
  /** 최소 선분 길이(이보다 짧으면 길이 0으로 본다) */
  minSegLen: 0.05, layer: [-4, 6], flatten: [0, 200], cell: 5,
} as const;
export const DEFAULTS = {
  curve: 'catmull' as CurveKind, layer: 0, oneWay: false, rotDeg: 0, floors: 2, flattenRadius: 12, buildingMaxSlope: 0.12, buildingMaxAlt: 40,
  /** 도시 섬 높이 격자 간격(m) */
  heightCell: 5,
} as const;

// ───────── 원본 ─────────
export interface CitySource {
  /** 형식 버전(CITY_SCHEMA_VERSION) */
  schemaVersion: number;
  /** 지도 개정. 세이브 보호 판단 기준(올리면 안전 위치 재검증) */
  cityRevision: number;
  /** 생성 알고리즘 버전(정수). 같은 원본+seed+generatorVersion → 같은 결과 */
  generatorVersion: number;
  seed: number;
  name?: string;
  /** 건축 가능 구역(해안선이 아님). 자기 교차 없는 단순 다각형 */
  bounds: Pt[];
  terrain: TerrainSource;
  roads: RoadSource[];
  nodes: NodeSource[];
  ramps: RampSource[];
  zones: ZoneSource[];
  parcels: ParcelSource[];
  buildings: BuildingSource[];
  anchors: AnchorSource[];
  parking: ParkingSlotSource[];
  greenery: GreenRule[];
  props: PropProfile[];
  exceptions: ExceptionSource[];
  /** 선택 시설. 현재는 물류 항구뿐 (docs/tech/PORT.md) */
  facilities?: FacilitiesSource;
}

// ── 지형 ──
export interface HeightGridRef {
  /** 격자 간격(m). 현재 5 */
  cell: number;
  /** 첫 칸 중심의 월드 좌표 */
  x0: number; z0: number;
  cols: number; rows: number;
  /** 고도 cm 정수의 행 우선 델타 인코딩 + base64. 인라인이거나 ref 파일 중 하나 */
  encoding: 'delta-cm-b64';
  data?: string;
  /** 별도 파일 경로(문서 base 기준). data 와 둘 다 있으면 data 우선 */
  ref?: string;
  /** 무결성 확인용 해시(선택) */
  hash?: string;
}
/** 시드 기반 저주파 비틀림(선택): 거리 기준을 fbm 으로 늘이고 줄여 둥근 윤곽·경사 폭을 불규칙하게 만든다. amp 0~0.9(상대 변동), lambda m(최대 파장), seed 정수 */
export interface TerrainWarp { amp: number; lambda: number; seed: number }
export type TerrainEdit =
  | {kind: 'pad'; id: string; x: number; z: number; r: number; y?: number; falloff: number; warp?: TerrainWarp}
  | {kind: 'corridor'; id: string; roadId: string; cut: number; fill: number; shoulder: number}
  | {kind: 'brush'; id: string; mode: 'raise' | 'lower' | 'flatten' | 'smooth'; r: number; strength: number; pts: Pt[]; warp?: TerrainWarp};
export interface TerrainSource {
  grid: HeightGridRef;
  edits: TerrainEdit[];
}

// ── 도로 ──
/** 구간별 단면 덮어쓰기(생략한 값은 등급 기본값) */
export type LanesOverride = Partial<Pick<RoadProfile, 'lanes' | 'laneW' | 'median' | 'parkL' | 'parkR' | 'walk' | 'plant' | 'shoulder'>>;
/** 높이 프로파일 제어점. s = 도로 시작점부터 누적거리(m), y = 도로면 해발. 생략하면 지형을 따라간다 */
export interface HeightKey { s: number; y: number }
export interface RoadSegment {
  id: string;
  /** 도로 pts 의 제어점 인덱스 구간 [from, to], from < to */
  from: number; to: number;
  layer: Layer;
  kind: SegKind;
  heights?: HeightKey[];
  lanes?: LanesOverride;
  oneWay?: boolean;
  /** 이 구간의 보행 허용(생략 시 등급 기본값) */
  pedAllowed?: boolean;
  /** 회전 제한 등 금지 연결 노드 ID(선택) */
  noTurn?: string[];
}
export interface RoadSource {
  id: string;
  name?: string;
  cls: RoadClass;
  pts: Pt[];
  curve: CurveKind;
  /** 생략 시 pts 전체를 덮는 지상 구간 1개로 본다 */
  segments?: RoadSegment[];
  /** 도로 전체 단면 덮어쓰기(구간 덮어쓰기보다 약함) */
  lanes?: LanesOverride;
  oneWay?: boolean;
  pedAllowed?: boolean;
}
export interface NodeSource {
  id: string;
  kind: NodeKind;
  at: Pt;
  layer: Layer;
  /** 연결 도로 ID들 */
  roads: string[];
  /** 지면 높이를 직접 정할 때만(선택) */
  y?: number;
}
/** 지상↔고가 등을 잇는 명시적 연결. 램프로만 층이 바뀐다 */
export interface RampSource {
  id: string;
  road: string;
  /** 램프 도로가 연결되는 두 노드 */
  fromNode: string; toNode: string;
  oneWay?: boolean;
}

// ── 구역·필지·건물 ──
export interface ZoneSource {
  id: string;
  use: ZoneUse;
  /** 표시 이름(선택, 24자 이하). 없어도 유효 */
  name?: string;
  poly: Pt[];
  /** 0~1 건물 밀도(생략 시 용도 기본) */
  density?: number;
  style?: BuildingStyle;
}
/** 도로 한쪽에 접한 대지. t0/t1 은 도로 시작점부터의 누적거리(m) — 제어점 삽입으로 미끄러지지 않는다 */
export interface ParcelSource {
  id: string;
  road: string;
  side: 'left' | 'right';
  t0: number; t1: number;
  /** 도로 경계에서 안쪽 깊이(m) */
  depth: number;
  zone?: string;
}
export interface DoorDef {
  /** 발자국 중심 기준 로컬 위치(회전 전). 가장자리 위에 있어야 한다 */
  x: number; z: number;
  /** 개구 폭·높이(m). 기본 SCALE.door */
  w: number; h: number;
  /** 바깥쪽 방향(회전 전 로컬): s=+z, n=-z, e=+x, w=-x */
  facing: 's' | 'n' | 'e' | 'w';
}
export interface InteriorDef {
  /** onsite = 실제 위치 실내, virtual = 개발 중 시험 지도용 가상 방 */
  mode: 'onsite' | 'virtual';
  door: DoorDef;
  /** 층 수·층고 */
  floors: number;
  floorH: number;
  /** 1층 바닥 윗면 해발(생략 시 빌더가 대지 높이에서 계산) */
  floorY?: number;
  /** 벽 두께·바닥 두께 */
  wallThick?: number;
  slab?: number;
  /** 방 배치 템플릿 ID(빌더 해석, 선택) */
  plan?: string;
}
export interface BuildingSource {
  /** 세이브 호환을 위한 안정 ID. 필지 ID 에서 파생해 명시한다 */
  id: string;
  parcel?: string;
  /** 발자국 중심 */
  x: number; z: number;
  /** 발자국 크기(회전 전): w = x 방향, d = z 방향 */
  w: number; d: number;
  /** 발자국 중심 둘레 회전(도). 양의 방향은 로컬 +z(남쪽 정면)가 +x(동쪽) 쪽으로 도는 방향. 기존 face 는 s:0 e:90 n:180 w:270 */
  rot: number;
  floors: number;
  style: BuildingStyle;
  wall?: string; roof?: string;
  purpose?: string;
  interior: InteriorDef;
  /** 지반 고도를 직접 고정할 때(선택) */
  groundY?: number;
}

// ── 앵커·주차·녹지·소품·예외 ──
export interface AnchorSource {
  id: string;
  kind: AnchorKind;
  x: number; z: number; y?: number; rot?: number;
  /** true 면 에디터/빌더가 옮길 수 없는 고정 앵커(다리 끝, 산악도로 시작 등) */
  fixed: boolean;
  /** 평탄화 반경(m). 이 안은 앵커 높이로 평지 */
  flattenRadius: number;
}
export interface ParkingSlotSource {
  id: string;
  kind: ParkingKind;
  x: number; z: number; rot: number;
  layer: Layer;
  road?: string;
  /** 고정 차량 ID(논리 차량과 1:1, 선택) */
  vehicleId?: string;
}
export interface Spacing { min: number; target: number; max: number }
export interface GreenRule {
  id: string;
  kind: GreenKind;
  /** 적용 대상: 도로 등급 또는 구역 용도 또는 구역 ID 중 하나 이상 */
  roadClass?: RoadClass; zoneUse?: ZoneUse; zone?: string;
  species: string[];
  spacing: Spacing;
  /** 건물 외벽·문·차도와의 최소 여유(m) */
  clearance: number;
  /** 0~1 지표 면적 비율 목표(lawn/forest) */
  coverage?: number;
}
export interface PropProfile {
  id: string;
  kind: PropKind;
  roadClass: RoadClass;
  side: PropSide;
  spacing: Spacing;
  /** 연석에서 바깥쪽으로 떨어진 거리(m) */
  offset: number;
  /** 교차로·횡단보도·문 앞 여유(m) */
  clearance: number;
  asset?: string;
}
export type ExceptionSource =
  | {kind: 'noBuild'; id: string; poly: Pt[]; reason?: string}
  | {kind: 'fixed'; id: string; target: string; x: number; z: number; rot?: number}
  | {kind: 'style'; id: string; target: string; style: BuildingStyle};

// ── 시설: 물류 항구 (선택 필드, schemaVersion 은 그대로) ──
// 좌표 x(동+)·z(남+), 각도 도(0 = 동, 90 = 남). 컨테이너는 실제 규격 12×2.4×2.6 m.
export const SHIP_KINDS = ['container', 'feeder'] as const;
export type ShipKind = (typeof SHIP_KINDS)[number];
export const PORT_RECT_KINDS = ['apron', 'pier'] as const;
export const PORT_BUILDING_KINDS = ['warehouse', 'office', 'gatehouse'] as const;
export const PORT_GUARD_POSTS = ['gate', 'pier', 'gangway'] as const;
/** 축 정렬 부두 상판. apron = 야적·안벽 판, pier = 돌출 피어 */
export interface PortRect { id: string; kind: (typeof PORT_RECT_KINDS)[number]; x0: number; z0: number; x1: number; z1: number }
/** 컨테이너 적재 칸 격자: 가로(x) cols × 세로(z) rows, 각 칸 12×2.4 m. fill = 채움 비율 0~1 */
export interface PortStackBlock { id: string; x0: number; z0: number; cols: number; rows: number; maxTiers: number; fill: number }
export interface PortBuilding { id: string; kind: (typeof PORT_BUILDING_KINDS)[number]; x0: number; z0: number; x1: number; z1: number; h: number }
/** 선석: 선박 중심 위치와 선수 방향(heading), 길이·허용 폭, 접안하는 안벽 상판 id */
export interface PortBerth { id: string; x: number; z: number; heading: number; length: number; beam: number; kinds: ShipKind[]; platform: string }
/** 겐트리 크레인: origin(x,z)는 두 다리 사이 중심, boom = 붐이 향하는 방향(도), gauge = 다리 간격, 레일은 boom 에 수직.
 *  approach = 야적장 교환 지점 → 크레인 레인까지의 트럭 경로 점들(마지막 점이 레인 위), slots = 담당하는 선박 칸 번호 범위 [from, to] */
export interface PortCrane { id: string; berth: string; x: number; z: number; boom: number; gauge: number; outreach: number; backreach: number; height: number; approach: Pt[]; /** 교환 컨테이너가 트럭 옆 어느 쪽(좌/우)에 놓이는가 */ swapSide: 1 | -1; slots: [number, number] }
export interface PortGate { x: number; z: number; /** 바깥(공공)쪽 방향(도) */ outward: number; width: number }
export interface PortAccess { pts: Pt[]; width: number }
export interface PortGuard { id: string; post: (typeof PORT_GUARD_POSTS)[number]; x: number; z: number; rot: number }
/** 외해 진입점부터 선석 중심까지의 항로. 마지막 점 = 선석 중심, 마지막 구간 방향 = 선석 heading */
export interface PortRoute { id: string; pts: Pt[]; /** 접안 직전/출항 직후 선수 방향을 선석 방향으로 고정하는 거리(m), 기본 70 */ hold?: number }
export interface PortShip { id: string; kind: ShipKind; berth: string; route: string; length: number; beam: number; draft: number; bays: number; rows: number; tiers: number; hull: string; /** 하루 주기(초) 안에서 외해 진입 시각 */ arriveAt: number; dwell: number }
export interface PortSchedule { seed: number; /** 하루 주기 = 낮 720 + 밤 240 */ periodSec: number; sailSec: number; settleSec: number; craneCycleSec: number }
export interface PortSource {
  id: string; name?: string;
  /** 상판 윗면 해발과 하부 기초 바닥 */
  deckY: number; baseY: number; /** 수면 해발(core/water SEA_Y) */ waterY: number;
  platforms: PortRect[];
  yard: { blocks: PortStackBlock[] };
  buildings: PortBuilding[];
  gate: PortGate; access: PortAccess;
  berths: PortBerth[]; cranes: PortCrane[]; guards: PortGuard[];
  routes: PortRoute[]; ships: PortShip[];
  schedule: PortSchedule;
}
export interface FacilitiesSource { port?: PortSource }
