// 에디터 공유 상태·실행 취소 이력. DOM 에 의존하지 않는다(순수 + 구독자 목록).
import type {AnchorKind, BuildingStyle, CitySource, CurveKind, Pt, RoadClass, RoadSource, ZoneUse} from '../city-schema.js';

export interface View { cx: number; cz: number; scale: number }
export type Tool = 'select' | 'draw' | 'zone' | 'anchor' | 'building' | 'brush';
export type ObjKind = 'zone' | 'anchor' | 'node' | 'building' | 'edit';
/** 도로 외 선택 대상. vert = 선택한 다각형 점(없으면 -1) */
export interface SelObj { kind: ObjKind; id: string; vert: number }
export interface BrushOpts { mode: 'raise' | 'lower' | 'flatten' | 'smooth'; r: number; strength: number }
export interface BldOpts { w: number; d: number; rot: number; floors: number; style: BuildingStyle }
export type Sev = 'error' | 'warn';
export interface Issue { sev: Sev; code: string; msg: string; road?: string; at?: Pt; path?: string }
export interface Rejected { owner: string; code: string; msg: string }
/** 컴파일 결과 중 3D 미리보기에 쓰는 부분(도로 중심선 xyz 평탄 배열, 배치된 건물) */
export interface CompiledGeo { roads: Array<{id: string; cls: string; xyz: number[]}>; buildings: Array<{id: string; x: number; z: number; w: number; d: number; rot: number; floors: number; style: string; groundY: number}> }
export interface CompiledInfo { name: string; revision: number; seed: number; sourceHash: string; rejected: Rejected[]; geo?: CompiledGeo }
/** 구독 종류: doc=도로/자료 변경, geom=기하만 변경(드래그 중), sel=선택, view=시점, ui=기타 */
export type Kind = 'doc' | 'geom' | 'sel' | 'view' | 'ui' | 'issues';

export interface Ed {
  doc: CitySource | null;
  name: string;
  view: View;
  tool: Tool;
  selRoad: string | null;
  selVert: number;
  selObj: SelObj | null;
  /** 점·도로 이동/삭제 시 nodes·parcels·heights 등 참조를 함께 갱신 */
  refs: boolean;
  zoneUse: ZoneUse;
  anchorKind: AnchorKind;
  brush: BrushOpts;
  bld: BldOpts;
  stroke: Pt[];
  /** 자동 교차로(도로 접촉·교차 → jx-* 노드) */
  autoJunc: boolean;
  /** 구역 브러시 반경(m)과 진행 중인 스트로크의 모드/용도, ⌥ 상태 */
  zbr: number;
  zmode: '' | 'extend' | 'new' | 'erase';
  zmodeUse: ZoneUse;
  alt: boolean;
  showHeight: boolean;
  showSlope: boolean;
  showZoneNames: boolean;
  terrainMsg: string;
  snapGrid: boolean;
  snapPts: boolean;
  grid: number;
  drawCls: RoadClass;
  drawCurve: CurveKind;
  draft: Pt[];
  issues: Issue[];
  compiled: CompiledInfo | null;
  dirty: boolean;
  msg: string;
  /** 마지막 편집의 자동 교차로 결과 문구 */
  jxMsg: string;
  undo: string[];
  redo: string[];
  ver: number;
  subs: Array<(k: Kind) => void>;
}

export const ed: Ed = {
  doc: null, name: '', view: {cx: 0, cz: 0, scale: 0.6}, tool: 'select', selRoad: null, selVert: -1, selObj: null, refs: true, zoneUse: 'residential', anchorKind: 'landmark',
  brush: {mode: 'raise', r: 30, strength: 1}, bld: {w: 10, d: 8, rot: 0, floors: 2, style: 'house'}, stroke: [], autoJunc: true, zbr: 12, zmode: '', zmodeUse: 'residential', alt: false, showHeight: false, showSlope: true, showZoneNames: true, terrainMsg: '',
  snapGrid: true, snapPts: true, grid: 5, drawCls: 'local', drawCurve: 'catmull', draft: [], issues: [], compiled: null,
  dirty: false, msg: '', jxMsg: '', undo: [], redo: [], ver: 0, subs: [],
};

export const emit = (k: Kind) => { for (const f of ed.subs) f(k); };
export const bump = () => { ed.ver++; };
export const roadById = (id: string | null): RoadSource | undefined => (id && ed.doc ? ed.doc.roads.find(r => r.id === id) : undefined);
export const selected = (): RoadSource | undefined => roadById(ed.selRoad);

const LIMIT = 100;
/** 되돌리기 대상: 에디터가 편집하는 모든 배열(도로·노드·램프·구역·필지·건물·앵커·주차·녹지·예외·지형 편집) */
const SLICES = ['roads', 'nodes', 'ramps', 'zones', 'parcels', 'buildings', 'anchors', 'parking', 'greenery', 'exceptions'] as const;
const snap = () => {
  const d = ed.doc as unknown as Record<string, unknown>, o: Record<string, unknown> = {};
  for (const k of SLICES) o[k] = d[k];
  o.edits = ed.doc!.terrain?.edits;
  o.name = d.name ?? null;
  return JSON.stringify(o);
};
/** 편집 직후(touched 전)·복원 직후 호출되는 훅. 자동 교차로가 등록한다(state 는 DOM·citygen 에 의존하지 않는다) */
export const hooks: {afterEdit?: (doc: CitySource) => void; restored?: (doc: CitySource) => void} = {};
/** 도로 드래그처럼 pushUndo 를 따로 한 편집이 끝났을 때 */
export function runAfterEdit() { if (ed.doc) hooks.afterEdit?.(ed.doc); }
/** 변경 직전에 호출한다(드래그는 첫 이동에서 한 번만) */
export function pushUndo() {
  if (!ed.doc) return;
  ed.undo.push(snap());
  if (ed.undo.length > LIMIT) ed.undo.shift();
  ed.redo = [];
}
/** 변경 뒤에 호출한다 */
export function touched(kind: Kind = 'doc') { bump(); ed.dirty = true; emit(kind); }
/** 한 번에 하나의 되돌리기 단위로 변경한다(도로 배열 전용 형태) */
export function mutate(fn: (roads: RoadSource[]) => void) {
  if (!ed.doc) return;
  pushUndo(); fn(ed.doc.roads); runAfterEdit(); touched('doc');
}
/** 문서 전체를 건드리는 변경(참조 갱신 포함)을 한 단위로 */
export function mutateDoc(fn: (doc: CitySource) => void) {
  if (!ed.doc) return;
  pushUndo(); fn(ed.doc); runAfterEdit(); touched('doc');
}
function restore(s: string) {
  const o = JSON.parse(s) as Record<string, unknown>, d = ed.doc as unknown as Record<string, unknown>;
  for (const k of SLICES) if (k in o && o[k] !== undefined) d[k] = o[k];
  if (o.name !== undefined) { if (typeof o.name === 'string') ed.doc!.name = o.name; else delete ed.doc!.name; }
  if (o.edits !== undefined && ed.doc!.terrain) ed.doc!.terrain.edits = o.edits as CitySource['terrain']['edits'];
  if (ed.selRoad && !roadById(ed.selRoad)) { ed.selRoad = null; ed.selVert = -1; }
  const r = selected();
  if (r && ed.selVert >= r.pts.length) ed.selVert = -1;
  if (ed.selObj && !objExists(ed.selObj)) ed.selObj = null;
  hooks.restored?.(ed.doc!);
  touched('doc'); emit('sel');
}
export function undo(): boolean {
  if (!ed.doc || !ed.undo.length) return false;
  ed.redo.push(snap()); restore(ed.undo.pop()!); return true;
}
export function redo(): boolean {
  if (!ed.doc || !ed.redo.length) return false;
  ed.undo.push(snap()); restore(ed.redo.pop()!); return true;
}
export function objList(kind: ObjKind): Array<{id: string}> {
  const d = ed.doc;
  if (!d) return [];
  return (kind === 'zone' ? d.zones : kind === 'anchor' ? d.anchors : kind === 'node' ? d.nodes : kind === 'building' ? d.buildings : d.terrain?.edits) ?? [];
}
export const objExists = (s: SelObj) => objList(s.kind).some(o => o.id === s.id);
export function objOf<T = any>(s: SelObj | null): T | undefined { return s ? (objList(s.kind).find(o => o.id === s.id) as T | undefined) : undefined; }
export function select(id: string | null, vert = -1) { ed.selRoad = id; ed.selVert = vert; ed.selObj = null; emit('sel'); }
export function selectObj(kind: ObjKind | null, id = '', vert = -1) {
  ed.selObj = kind ? {kind, id, vert} : null;
  if (kind) { ed.selRoad = null; ed.selVert = -1; }
  emit('sel');
}
export function setMsg(m: string) { ed.msg = m; emit('ui'); }
