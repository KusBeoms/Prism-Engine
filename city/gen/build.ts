// citygen 진입점. 파이프라인 순서(확장 지점 표시: ▶):
//  0 검증/해시 → 1 기본 지형 해독 → 2 1차 편집(pad/brush) → 3 도로 해석(표본·종단·단면; 한도 위반 거부) → 4 노드/교차로 검출·팔
//  → 5 교차로 형상(포장·모서리·트림) → 6 지형 회랑(corridor, 자동 포함) + 교차로 포장 평탄화 → 7 리본 메시(청크) → 8 출력
//  ▶ 6.5 앵커 평탄화 패드·필지/건물 대지(placement 에이전트)  ▶ 7.5 소품/건물/주차 배치, 충돌체, 길찾기 그래프(placement 에이전트)
// 결정성: 난수·시계·객체 키 순서에 의존하지 않는다. 같은 source+seed+generatorVersion → 같은 compiled(시간 통계 제외).
import {CITY_SCHEMA_VERSION} from '../city-schema.js';
import type {CitySource, TerrainEdit} from '../city-schema.js';
import {CITY_COMPILED_VERSION} from '../city-compiled.js';
import type {CityCompiled, CompiledJunction} from '../city-compiled.js';
import {validateCitySource} from '../city-validate.js';
import {rnd, sourceHash} from './bytes.js';
import {buildArms, detectClusters} from './junctions.js';
import {buildJunction} from './junction-geom.js';
import type {JunctionGeom} from './junction-geom.js';
import {MeshSet} from './ribbon-mesh.js';
import {emitJunction, emitPiece, roadPieces} from './ribbons.js';
import {DEFAULT_ROAD_OPTS, DEFAULT_THIN, KIND_CODE, SEC, resolveRoad, sideEdges, thinIndices, toCompiledRoad} from './roads.js';
import type {Rej, RoadGeo} from './roads.js';
import {PAVE_DROP, applyPreEdits, carveCorridor, cloneTerrain, encodeTerrainCompiled, rasterTriangles, sampleBilinear, terrainFromSource} from './terrain.js';
import type {BaseHeights, CorridorVertex, Terrain} from './terrain.js';
import type {CitySource as _CS} from '../city-schema.js';
import {PlaceCtx} from './place-ctx.js';
import {placeAll} from './place.js';
import type {PlaceModel} from './place.js';
import {sightAxesOf} from './sight.js';
import {assemble} from './assemble.js';
import {bakePort} from './port-bake.js';
import type {PlaceStats} from './assemble.js';
import type {PlaceOpts, SightAxis} from './place-types.js';

export const GENERATOR_VERSION_CITYGEN = 1;
export interface BuildOptions {
  /** terrain.grid 에 data 가 없을 때 호출자가 디코딩해 넘기는 기본 높이(cm) */
  baseHeights?: BaseHeights;
  chunkSize?: number;
  /** 조밀 표본 간격(m), 기본 LIMITS.sampleStep */
  step?: number;
  uv?: boolean;
  /** 리본 정점 수 상한(초과하면 overflow 보고) */
  maxVertices?: number;
  validate?: boolean;
  surfaceMask?: boolean;
  /** true 면 result.debug 에 도로/교차로 중간 결과를 담는다 (직렬화 대상 아님) */
  debug?: boolean;
}
export interface BuildStats {
  roadsIn: number; roadsOut: number; roadsRejected: number; roadLengthM: number;
  junctions: number; ribbonChunks: number; ribbonVertices: number; ribbonTriangles: number; verticesBySurface: Record<string, number>; overflow: boolean;
  compiledJsonBytes: number;
  roadInfo: {id: string; cls: string; length: number; maxGrade: number; limit: number; samples: number}[];
  timingsMs: Record<string, number>;
}
export interface BuildDebug { roads: RoadGeo[]; junctions: JunctionGeom[]; terrainPre: Terrain; terrainFinal: Terrain; pieces: {ri: number; sa: number; sb: number}[] }
export interface BuildResult {
  compiled: Partial<CityCompiled>;
  rejected: Rej[];
  warnings: Rej[];
  stats: BuildStats;
  debug?: BuildDebug;
}
export class BuildError extends Error {
  constructor(msg: string, readonly errors: unknown[] = []) { super(msg); this.name = 'BuildError'; }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);
const AUTO_CORRIDOR = {cut: 3, fill: 3, shoulder: 1.5};

/** 도로의 ground/ramp 연속 구간을 회랑 꼭짓점 목록들로 */
function corridorRuns(r: RoadGeo, terrain: Terrain): CorridorVertex[][] {
  const runs: CorridorVertex[][] = [];
  let a = -1;
  // 지상 구간 + 땅에 가까운(2m 미만) 램프 구간만 깎고 쌓는다. 높은 램프/교량은 지형을 건드리지 않는다(고가)
  const ok = (i: number) => { const k = KIND_CODE[r.segs[r.segIdx[i]].kind]; return k === 0 || (k === 3 && r.y[i] - sampleBilinear(terrain, r.x[i], r.z[i]) < 2.0); };
  const flush = (b: number) => {
    if (a < 0 || b <= a) { a = -1; return; }
    const run: CorridorVertex[] = [];
    for (const i of thinIndices(r, a, b, {pos: 0.25, y: 0.05, w: 0.2, maxStep: 5})) {
      const L = sideEdges(r.sec, i * SEC.N, false), R = sideEdges(r.sec, i * SEC.N, true);
      run.push({x: r.x[i], z: r.z[i], y: r.y[i], wcL: L.e3, wcR: R.e3, hwL: L.e5, hwR: R.e5});
    }
    runs.push(run); a = -1;
  };
  for (let i = 0; i < r.n; i++) { if (ok(i)) { if (a < 0) a = i; } else flush(i - 1); }
  flush(r.n - 1);
  return runs;
}

export function buildRoadsAndTerrain(source: CitySource, opts: BuildOptions = {}): BuildResult {
  const T: Record<string, number> = {}, tick = (k: string, t0: number) => { T[k] = Math.round(now() - t0); };
  let t = now();
  if (opts.validate !== false) {
    const v = validateCitySource(source);
    if (!v.ok) throw new BuildError(`원본 검증 실패: ${v.errors.slice(0, 3).map(e => `${e.path} ${e.code}`).join('; ')}`, v.errors);
  }
  const hash = sourceHash(source), chunk = opts.chunkSize ?? 64, rejected: Rej[] = [], warnings: Rej[] = [];
  const terrainPre = terrainFromSource(source, opts.baseHeights);
  applyPreEdits(terrainPre, source.terrain.edits);
  tick('terrainPre', t); t = now();
  // 3 도로
  const ro = {...DEFAULT_ROAD_OPTS, ...(opts.step ? {step: opts.step} : {})};
  const geos: RoadGeo[] = [];
  for (const rs of source.roads) {
    const res = resolveRoad(rs, terrainPre, ro);
    rejected.push(...res.rejected); warnings.push(...res.warnings);
    if (res.road) geos.push(res.road);
  }
  tick('roads', t); t = now();
  // 4~5 교차로
  const clusters = detectClusters(geos, source.nodes, source.ramps, warnings).filter(c => c.members.length > 0);
  clusters.forEach(c => buildArms(c, geos));
  const juncs = clusters.filter(c => c.arms.length > 0).map(c => buildJunction(c, geos));
  for (const j of juncs) for (const w of j.warnings) warnings.push({owner: j.id, code: 'junction-warning', msg: w});
  tick('junctions', t); t = now();
  // 6 지형 회랑 + 포장 평탄화
  const terrain = cloneTerrain(terrainPre), byId = new Map(geos.map(g => [g.id, g]));
  const explicit = new Map<string, Extract<TerrainEdit, {kind: 'corridor'}>>();
  for (const e of source.terrain.edits) {
    if (e.kind !== 'corridor') continue;
    if (!byId.has(e.roadId)) { rejected.push({owner: e.id, code: 'corridor-road-missing', msg: `회랑 편집이 가리키는 도로 ${e.roadId} 가 없거나 거부되었다`}); continue; }
    explicit.set(e.roadId, e);
  }
  for (const g of geos) {
    const e = explicit.get(g.id), p = e ? {cut: e.cut, fill: e.fill, shoulder: e.shoulder} : AUTO_CORRIDOR;
    for (const run of corridorRuns(g, terrainPre)) carveCorridor(terrain, run, p.cut, p.fill, p.shoulder);
  }
  for (const j of juncs) {
    rasterTriangles(terrain, j.pave, PAVE_DROP);
    const bt: number[] = [];
    for (const b of j.bands) for (let i = 0; i + 1 < b.inner.length; i++) {
      const a0 = b.inner[i], a1 = b.inner[i + 1], o0 = b.outer[i], o1 = b.outer[i + 1];
      bt.push(...a0, ...o0, ...a1, ...o0, ...o1, ...a1);
    }
    rasterTriangles(terrain, bt, 0.1);
  }
  tick('terrain', t); t = now();
  // 7 리본
  const tol = {...DEFAULT_THIN}, mesh = new MeshSet(chunk, opts.uv !== false, opts.maxVertices ?? 4_000_000), ctx = {mesh, terrain, tol};
  const pieces = roadPieces(geos, clusters.filter(c => c.arms.length > 0));
  for (const pc of pieces) emitPiece(ctx, geos[pc.ri], pc);
  for (const j of juncs) emitJunction(ctx, j);
  if (mesh.overflow) rejected.push({owner: '*', code: 'ribbon-overflow', msg: `리본 정점 수가 상한을 넘어 일부가 잘렸다`});
  tick('ribbons', t); t = now();
  // 8 출력
  const junctions: CompiledJunction[] = juncs.map(j => ({
    id: j.id, kind: j.kind, layer: j.layer, x: rnd(j.x), y: rnd(j.y), z: rnd(j.z), polygon: j.polygon.map(p => [rnd(p[0]), rnd(p[1])] as [number, number]),
    arms: j.arms.map(a => ({road: a.roadId, dir: a.dir, s: rnd(a.sNode), trim: rnd(a.trim)})),
    ...(j.island ? {island: {x: rnd(j.island.cx), z: rnd(j.island.cz), r: rnd(j.island.r)}} : {}), crosswalks: j.crosswalks.length, stopLines: j.stops.length}));
  const compiled: Partial<CityCompiled> = {
    header: {compiledVersion: CITY_COMPILED_VERSION, schemaVersion: source.schemaVersion ?? CITY_SCHEMA_VERSION, cityRevision: source.cityRevision, generatorVersion: source.generatorVersion, seed: source.seed, sourceHash: hash, chunkSize: chunk},
    bounds: source.bounds.map(p => [p[0], p[1]] as [number, number]),
    terrain: encodeTerrainCompiled(terrain, opts.surfaceMask !== false),
    roads: geos.map(g => toCompiledRoad(g, tol)),
    ribbons: mesh.chunks(),
    junctions,
    rejected: rejected.map(r => ({owner: r.owner, code: r.code, msg: r.msg})),
  };
  tick('encode', t);
  const ms = mesh.stats();
  const stats: BuildStats = {
    roadsIn: source.roads.length, roadsOut: geos.length, roadsRejected: source.roads.length - geos.length, roadLengthM: Math.round(geos.reduce((s, g) => s + g.length, 0)),
    junctions: juncs.length, ribbonChunks: compiled.ribbons!.length, ribbonVertices: ms.vertices, ribbonTriangles: ms.triangles, verticesBySurface: ms.bySurface, overflow: ms.overflow,
    compiledJsonBytes: JSON.stringify(compiled).length,
    roadInfo: geos.map((g, i) => ({id: g.id, cls: g.cls, length: rnd(g.length), maxGrade: rnd(g.grade.reduce((m, v) => Math.max(m, Math.abs(v)), 0), 4), limit: g.maxGrade, samples: compiled.roads![i].samples.length})),
    timingsMs: T,
  };
  const res: BuildResult = {compiled, rejected, warnings, stats};
  if (opts.debug) res.debug = {roads: geos, junctions: juncs, terrainPre, terrainFinal: terrain, pieces: pieces.map(p => ({ri: p.ri, sa: p.sa, sb: p.sb}))};
  return res;
}

// ───────── 전체 파이프라인: 도로·지형 + 배치(필지·건물·소품·녹지·주차·그래프·충돌체) ─────────
export interface CityOptions extends BuildOptions {
  place?: PlaceOpts;
  /** false 면 도로·지형만(기존 buildRoadsAndTerrain 과 같음) */
  placement?: boolean;
}
export interface BuildCache { source: CitySource; opts: CityOptions; roads: RoadGeo[]; junctions: JunctionGeom[]; terrainRoads: Terrain; model: PlaceModel; axes: SightAxis[]; base: BuildResult; globalSig: string; zoneSig: Record<string, string> }
export interface CityBuildResult extends BuildResult { place?: PlaceStats; cache?: BuildCache; ctx?: PlaceCtx }

/** 완전한 도시 빌드. 같은 source+seed+generatorVersion → 같은 compiled (stats.timingsMs 제외) */
export function buildCity(source: CitySource, opts: CityOptions = {}): CityBuildResult {
  const base = buildRoadsAndTerrain(source, {...opts, debug: true});
  if (opts.placement === false) { if (!opts.debug) delete base.debug; return base; }
  const d = base.debug!, popts = opts.place ?? {}, T = base.stats.timingsMs;
  let t = now();
  const ctx = new PlaceCtx(source, d.roads, d.junctions, d.terrainFinal, popts);
  const axes = sightAxesOf(source, popts.sightAxes);
  const model = placeAll(ctx, axes);
  T.place = Math.round(now() - t);
  return finish(source, opts, base, ctx, model, axes);
}
/** zones·parcels 를 뺀 원본의 해시: 같으면 구역 단위 재빌드가 가능하다 */
export const globalSigOf = (s: CitySource): string => sourceHash({...s, zones: [], parcels: []});
/** 모델 → CityBuildResult (rebuildZone 도 사용) */
export function finish(source: CitySource, opts: CityOptions, base: BuildResult, ctx: PlaceCtx, model: PlaceModel, axes: SightAxis[]): CityBuildResult {
  const d = base.debug!, T = {...base.stats.timingsMs};
  const a = assemble(ctx, model, d.terrainFinal, opts.surfaceMask !== false, T);
  const compiled: Partial<CityCompiled> = {...base.compiled, ...a.compiled};
  compiled.rejected = [...(base.compiled.rejected ?? []), ...a.extraRejected];
  const port = bakePort(source, a.terrainFinal);
  if (port) { compiled.port = port; compiled.colliders = [...(compiled.colliders ?? []), ...port.colliders]; }
  const rejected = [...base.rejected, ...a.extraRejected];
  const stats: BuildStats = {...base.stats, timingsMs: T, compiledJsonBytes: JSON.stringify(compiled).length};
  const res: CityBuildResult = {compiled, rejected, warnings: base.warnings, stats, place: a.stats, cache: {source, opts, roads: d.roads, junctions: d.junctions, terrainRoads: d.terrainFinal, model, axes, base, globalSig: globalSigOf(source), zoneSig: Object.fromEntries(source.zones.map(z => [z.id, sourceHash(z)]))}, ctx};
  if (opts.debug) res.debug = {...d, terrainFinal: a.terrainFinal};
  return res;
}
export {validateCitySource};
