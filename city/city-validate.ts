// city.source.json 순수 검증. city-schema.ts 의 상수·타입만 사용한다(게임 데이터/월드 모듈 import 금지).
// 게임(boot.ts)·에디터·Node 빌더가 같은 함수를 쓴다. 입력은 JSON.parse 결과(unknown).
import {
  ANCHOR_KINDS, BUILDING_STYLES, CURVE_KINDS, GREEN_KINDS, LIMITS, NODE_KINDS, PARKING_KINDS, PROP_KINDS, PROP_SIDES, RANGES, ROAD_CLASSES,
  SEG_KINDS, SUPPORTED_SCHEMA_VERSIONS, ZONE_USES,
} from './city-schema.js';
import {validatePort} from './city-validate-port.js';

export type ErrorCode =
  | 'not-object' | 'missing' | 'type' | 'range' | 'non-finite' | 'unsupported-version' | 'duplicate-id' | 'bad-ref' | 'bad-id'
  | 'zero-length' | 'bad-width' | 'self-intersect' | 'degenerate-poly' | 'too-many' | 'bad-enum' | 'order';
export interface ValidationError { path: string; code: ErrorCode; msg: string }
export interface ValidationResult { ok: boolean; errors: ValidationError[] }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_ERRORS = 200;

class Ctx {
  errors: ValidationError[] = [];
  err(path: string, code: ErrorCode, msg: string) {
    if (this.errors.length < MAX_ERRORS) this.errors.push({path, code, msg});
  }
  /** 유한 수 + 범위. 통과하면 값을 돌려준다 */
  num(path: string, v: unknown, lo = -Infinity, hi = Infinity, required = true): number | undefined {
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'number') { this.err(path, v === undefined ? 'missing' : 'type', `숫자여야 합니다 (받은 값: ${v === undefined ? '없음' : typeof v})`); return undefined; }
    if (!Number.isFinite(v)) { this.err(path, 'non-finite', '유한한 숫자가 아닙니다 (NaN/Infinity)'); return undefined; }
    if (v < lo || v > hi) { this.err(path, 'range', `범위 ${lo}~${hi} 를 벗어났습니다 (${v})`); return undefined; }
    return v;
  }
  int(path: string, v: unknown, lo: number, hi: number, required = true): number | undefined {
    const n = this.num(path, v, lo, hi, required);
    if (n !== undefined && !Number.isInteger(n)) { this.err(path, 'type', `정수여야 합니다 (${n})`); return undefined; }
    return n;
  }
  id(path: string, v: unknown): string | undefined {
    if (typeof v !== 'string' || v.length === 0 || v.length > LIMITS.id) { this.err(path, v === undefined ? 'missing' : 'bad-id', `ID 는 1~${LIMITS.id}자 문자열이어야 합니다`); return undefined; }
    return v;
  }
  oneOf(path: string, v: unknown, list: readonly string[], required = true): string | undefined {
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || !list.includes(v)) { this.err(path, 'bad-enum', `허용값: ${list.join(', ')}`); return undefined; }
    return v;
  }
  arr(path: string, v: unknown, max: number): unknown[] | undefined {
    if (!Array.isArray(v)) { this.err(path, v === undefined ? 'missing' : 'type', '배열이어야 합니다'); return undefined; }
    if (v.length > max) { this.err(path, 'too-many', `항목 수 상한 ${max} 초과 (${v.length})`); return undefined; }
    return v;
  }
  pt(path: string, v: unknown): [number, number] | undefined {
    if (!Array.isArray(v) || v.length !== 2) { this.err(path, 'type', '[x, z] 두 수여야 합니다'); return undefined; }
    const x = this.num(`${path}[0]`, v[0], -RANGES.coord, RANGES.coord), z = this.num(`${path}[1]`, v[1], -RANGES.coord, RANGES.coord);
    return x === undefined || z === undefined ? undefined : [x, z];
  }
  pts(path: string, v: unknown, max: number, min: number): [number, number][] | undefined {
    const a = this.arr(path, v, max);
    if (!a) return undefined;
    if (a.length < min) { this.err(path, 'degenerate-poly', `점이 최소 ${min}개 필요합니다 (${a.length})`); return undefined; }
    const out: [number, number][] = [];
    a.forEach((p, i) => { const q = this.pt(`${path}[${i}]`, p); if (q) out.push(q); });
    return out.length === a.length ? out : undefined;
  }
  /** 컬렉션 순회 + ID 중복 검사. 반환: id → 항목 */
  coll(path: string, v: unknown, max: number, each: (o: Obj, p: string, i: number) => void): Map<string, Obj> {
    const ids = new Map<string, Obj>();
    const a = this.arr(path, v, max);
    if (!a) return ids;
    a.forEach((o, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(o)) { this.err(p, 'not-object', '객체여야 합니다'); return; }
      const id = this.id(`${p}.id`, o.id);
      if (id !== undefined) {
        if (ids.has(id)) this.err(`${p}.id`, 'duplicate-id', `중복된 ID "${id}"`);
        else ids.set(id, o);
      }
      each(o, p, i);
    });
    return ids;
  }
  ref(path: string, v: unknown, set: Map<string, unknown>, what: string, required = true) {
    if (v === undefined && !required) return;
    if (typeof v !== 'string' || !set.has(v)) this.err(path, 'bad-ref', `존재하지 않는 ${what} 참조: ${String(v)}`);
  }
}

// ───────── 기하 ─────────
const polyLen = (p: [number, number][]) => {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
};
const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
/** 두 선분이 끝점 접촉을 제외하고 진짜 교차하는가 */
function segCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const d1 = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]), d2 = cross(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  const d3 = cross(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]), d4 = cross(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
function polyArea(p: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; }
  return s / 2;
}
/** 닫힌 다각형 검사: 면적 0, 이웃하지 않는 변의 교차, 같은 점 중복 */
function checkPoly(c: Ctx, path: string, p: [number, number][]) {
  const n = p.length;
  for (let i = 0; i < n; i++) {
    if (Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]) < RANGES.minSegLen) { c.err(`${path}[${i}]`, 'zero-length', '이웃한 점이 같습니다'); return; }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) { c.err(path, 'self-intersect', `변 ${i} 와 변 ${j} 가 교차합니다`); return; }
    }
  }
  // 나비넥타이형은 부호 면적이 0 일 수 있어 교차 검사 뒤에 본다
  if (Math.abs(polyArea(p)) < 1e-6) c.err(path, 'degenerate-poly', '면적이 0 인 다각형입니다');
}

// ───────── 항목별 검사 ─────────
function checkRoads(c: Ctx, src: Obj, lens: Map<string, number>): Map<string, Obj> {
  return c.coll('roads', src.roads, LIMITS.roads, (r, p) => {
    c.oneOf(`${p}.cls`, r.cls, ROAD_CLASSES);
    c.oneOf(`${p}.curve`, r.curve, CURVE_KINDS);
    const pts = c.pts(`${p}.pts`, r.pts, LIMITS.roadPts, 2);
    if (pts) {
      for (let i = 1; i < pts.length; i++) {
        if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) < RANGES.minSegLen) c.err(`${p}.pts[${i}]`, 'zero-length', `길이 0 인 선분 (점 ${i - 1}→${i})`);
      }
      if (typeof r.id === 'string') lens.set(r.id, polyLen(pts));
    }
    checkLanes(c, `${p}.lanes`, r.lanes);
    if (r.segments !== undefined) checkSegments(c, `${p}.segments`, r.segments, pts ? pts.length : 0);
  });
}
function checkLanes(c: Ctx, path: string, v: unknown) {
  if (v === undefined) return;
  if (!isObj(v)) { c.err(path, 'not-object', '객체여야 합니다'); return; }
  for (const k of ['lanes', 'laneW', 'median', 'parkL', 'parkR', 'walk', 'plant', 'shoulder']) {
    if (v[k] === undefined) continue;
    const n = c.num(`${path}.${k}`, v[k], 0, RANGES.roadWidth);
    if (n === undefined) continue;
    if (k === 'lanes' && (!Number.isInteger(n) || n < 1 || n > 8)) c.err(`${path}.lanes`, 'range', '차로 수는 1~8 정수');
    if (k === 'laneW' && n <= 0) c.err(`${path}.laneW`, 'bad-width', '차로 폭은 0 보다 커야 합니다');
  }
}
function checkSegments(c: Ctx, path: string, v: unknown, npts: number) {
  const ids = c.coll(path, v, LIMITS.segmentsPerRoad, (s, p) => {
    const from = c.int(`${p}.from`, s.from, 0, Math.max(0, npts - 1)), to = c.int(`${p}.to`, s.to, 0, Math.max(0, npts - 1));
    if (from !== undefined && to !== undefined && from >= to) c.err(p, 'zero-length', `구간 from(${from}) 은 to(${to}) 보다 작아야 합니다`);
    c.int(`${p}.layer`, s.layer, RANGES.layer[0], RANGES.layer[1]);
    const kind = c.oneOf(`${p}.kind`, s.kind, SEG_KINDS);
    checkLanes(c, `${p}.lanes`, s.lanes);
    if (s.heights !== undefined) {
      const h = c.arr(`${p}.heights`, s.heights, LIMITS.heightPtsPerSeg);
      let prev = -Infinity;
      h?.forEach((k, i) => {
        if (!isObj(k)) { c.err(`${p}.heights[${i}]`, 'not-object', '{s,y} 객체여야 합니다'); return; }
        const ks = c.num(`${p}.heights[${i}].s`, k.s, 0, RANGES.coord);
        c.num(`${p}.heights[${i}].y`, k.y, -RANGES.height, RANGES.height);
        if (ks !== undefined) { if (ks <= prev) c.err(`${p}.heights[${i}].s`, 'order', 's 는 증가해야 합니다'); prev = ks; }
      });
    } else if (kind === 'bridge' || kind === 'ramp') c.err(`${p}.heights`, 'missing', `${kind} 구간은 높이 프로파일이 필요합니다`);
  });
  void ids;
}
function checkNodes(c: Ctx, src: Obj, roads: Map<string, Obj>): Map<string, Obj> {
  return c.coll('nodes', src.nodes, LIMITS.nodes, (n, p) => {
    c.oneOf(`${p}.kind`, n.kind, NODE_KINDS);
    c.pt(`${p}.at`, n.at);
    c.int(`${p}.layer`, n.layer, RANGES.layer[0], RANGES.layer[1]);
    c.num(`${p}.y`, n.y, -RANGES.height, RANGES.height, false);
    c.arr(`${p}.roads`, n.roads, 32)?.forEach((r, i) => c.ref(`${p}.roads[${i}]`, r, roads, '도로'));
  });
}
function checkZones(c: Ctx, src: Obj) {
  return c.coll('zones', src.zones, LIMITS.zones, (z, p) => {
    c.oneOf(`${p}.use`, z.use, ZONE_USES);
    if (z.name !== undefined && (typeof z.name !== 'string' || z.name.length > 24)) c.err(`${p}.name`, 'type', '구역 이름은 24자 이하 문자열이어야 합니다');
    c.oneOf(`${p}.style`, z.style, BUILDING_STYLES, false);
    c.num(`${p}.density`, z.density, 0, 1, false);
    const poly = c.pts(`${p}.poly`, z.poly, LIMITS.zonePts, 3);
    if (poly) checkPoly(c, `${p}.poly`, poly);
  });
}
function checkBuildings(c: Ctx, src: Obj, parcels: Map<string, Obj>) {
  return c.coll('buildings', src.buildings, LIMITS.buildings, (b, p) => {
    c.ref(`${p}.parcel`, b.parcel, parcels, '필지', false);
    c.num(`${p}.x`, b.x, -RANGES.coord, RANGES.coord); c.num(`${p}.z`, b.z, -RANGES.coord, RANGES.coord);
    const [lo, hi] = RANGES.buildingSide;
    const w = c.num(`${p}.w`, b.w, lo, hi), d = c.num(`${p}.d`, b.d, lo, hi);
    c.num(`${p}.rot`, b.rot, -RANGES.rot, RANGES.rot);
    c.int(`${p}.floors`, b.floors, 1, LIMITS.floors);
    c.oneOf(`${p}.style`, b.style, BUILDING_STYLES);
    const it = b.interior;
    if (!isObj(it)) { c.err(`${p}.interior`, it === undefined ? 'missing' : 'not-object', '실내 정의가 필요합니다'); return; }
    c.oneOf(`${p}.interior.mode`, it.mode, ['onsite', 'virtual']);
    c.int(`${p}.interior.floors`, it.floors, 1, LIMITS.floors);
    c.num(`${p}.interior.floorH`, it.floorH, 2.4, 8);
    c.num(`${p}.interior.floorY`, it.floorY, -RANGES.height, RANGES.height, false);
    const dr = it.door;
    if (!isObj(dr)) { c.err(`${p}.interior.door`, dr === undefined ? 'missing' : 'not-object', '문 정의가 필요합니다'); return; }
    const dx = c.num(`${p}.interior.door.x`, dr.x, -RANGES.buildingSide[1], RANGES.buildingSide[1]);
    const dz = c.num(`${p}.interior.door.z`, dr.z, -RANGES.buildingSide[1], RANGES.buildingSide[1]);
    const dw = c.num(`${p}.interior.door.w`, dr.w, 0, 10), dh = c.num(`${p}.interior.door.h`, dr.h, 0, 10);
    if (dw !== undefined && dw <= 0) c.err(`${p}.interior.door.w`, 'bad-width', '문 폭은 0 보다 커야 합니다');
    if (dh !== undefined && dh <= 0) c.err(`${p}.interior.door.h`, 'bad-width', '문 높이는 0 보다 커야 합니다');
    c.oneOf(`${p}.interior.door.facing`, dr.facing, ['s', 'n', 'e', 'w']);
    if (w !== undefined && d !== undefined && dx !== undefined && dz !== undefined && (Math.abs(dx) > w / 2 + 1e-6 || Math.abs(dz) > d / 2 + 1e-6)) {
      c.err(`${p}.interior.door`, 'range', '문 위치가 발자국 밖입니다');
    }
  });
}
function checkParcels(c: Ctx, src: Obj, roads: Map<string, Obj>, lens: Map<string, number>, zones: Map<string, Obj>) {
  return c.coll('parcels', src.parcels, LIMITS.parcels, (q, p) => {
    c.ref(`${p}.road`, q.road, roads, '도로');
    c.oneOf(`${p}.side`, q.side, ['left', 'right']);
    const t0 = c.num(`${p}.t0`, q.t0, 0, RANGES.coord), t1 = c.num(`${p}.t1`, q.t1, 0, RANGES.coord);
    if (t0 !== undefined && t1 !== undefined) {
      if (t1 - t0 < RANGES.minSegLen) c.err(p, 'zero-length', `t1(${t1}) 은 t0(${t0}) 보다 커야 합니다`);
      const len = typeof q.road === 'string' ? lens.get(q.road) : undefined;
      if (len !== undefined && t1 > len + 0.5) c.err(`${p}.t1`, 'range', `도로 길이(${len.toFixed(1)}m) 를 넘었습니다`);
    }
    const dep = c.num(`${p}.depth`, q.depth, -RANGES.roadWidth * 10, RANGES.roadWidth * 10);
    if (dep !== undefined && dep <= 0) c.err(`${p}.depth`, 'bad-width', '필지 깊이는 0 보다 커야 합니다');
    c.ref(`${p}.zone`, q.zone, zones, '구역', false);
  });
}
function checkRest(c: Ctx, src: Obj, roads: Map<string, Obj>, zones: Map<string, Obj>, buildings: Map<string, Obj>, nodes: Map<string, Obj>) {
  c.coll('ramps', src.ramps, LIMITS.ramps, (r, p) => {
    c.ref(`${p}.road`, r.road, roads, '도로');
    c.ref(`${p}.fromNode`, r.fromNode, nodes, '노드'); c.ref(`${p}.toNode`, r.toNode, nodes, '노드');
    if (r.fromNode !== undefined && r.fromNode === r.toNode) c.err(p, 'zero-length', '램프 시작/끝 노드가 같습니다');
  });
  c.coll('anchors', src.anchors, LIMITS.anchors, (a, p) => {
    c.oneOf(`${p}.kind`, a.kind, ANCHOR_KINDS);
    c.num(`${p}.x`, a.x, -RANGES.coord, RANGES.coord); c.num(`${p}.z`, a.z, -RANGES.coord, RANGES.coord);
    c.num(`${p}.y`, a.y, -RANGES.height, RANGES.height, false);
    if (typeof a.fixed !== 'boolean') c.err(`${p}.fixed`, a.fixed === undefined ? 'missing' : 'type', 'true/false 여야 합니다');
    c.num(`${p}.flattenRadius`, a.flattenRadius, RANGES.flatten[0], RANGES.flatten[1]);
  });
  c.coll('parking', src.parking, LIMITS.parking, (s, p) => {
    c.oneOf(`${p}.kind`, s.kind, PARKING_KINDS);
    c.num(`${p}.x`, s.x, -RANGES.coord, RANGES.coord); c.num(`${p}.z`, s.z, -RANGES.coord, RANGES.coord);
    c.num(`${p}.rot`, s.rot, -RANGES.rot, RANGES.rot);
    c.int(`${p}.layer`, s.layer, RANGES.layer[0], RANGES.layer[1]);
    c.ref(`${p}.road`, s.road, roads, '도로', false);
  });
  const spacing = (p: string, v: unknown) => {
    if (!isObj(v)) { c.err(p, v === undefined ? 'missing' : 'not-object', '{min,target,max} 가 필요합니다'); return; }
    const [lo, hi] = RANGES.propSpacing;
    const mn = c.num(`${p}.min`, v.min, lo, hi), tg = c.num(`${p}.target`, v.target, lo, hi), mx = c.num(`${p}.max`, v.max, lo, hi);
    if (mn !== undefined && tg !== undefined && mx !== undefined && !(mn <= tg && tg <= mx)) c.err(p, 'order', 'min <= target <= max 여야 합니다');
  };
  c.coll('greenery', src.greenery, LIMITS.greenery, (g, p) => {
    c.oneOf(`${p}.kind`, g.kind, GREEN_KINDS); c.oneOf(`${p}.roadClass`, g.roadClass, ROAD_CLASSES, false); c.oneOf(`${p}.zoneUse`, g.zoneUse, ZONE_USES, false);
    c.ref(`${p}.zone`, g.zone, zones, '구역', false);
    c.arr(`${p}.species`, g.species, 64); spacing(`${p}.spacing`, g.spacing);
    c.num(`${p}.clearance`, g.clearance, 0, 50); c.num(`${p}.coverage`, g.coverage, 0, 1, false);
  });
  c.coll('props', src.props, LIMITS.propProfiles, (g, p) => {
    c.oneOf(`${p}.kind`, g.kind, PROP_KINDS); c.oneOf(`${p}.roadClass`, g.roadClass, ROAD_CLASSES); c.oneOf(`${p}.side`, g.side, PROP_SIDES);
    spacing(`${p}.spacing`, g.spacing); c.num(`${p}.offset`, g.offset, 0, 50); c.num(`${p}.clearance`, g.clearance, 0, 50);
  });
  c.coll('exceptions', src.exceptions, LIMITS.exceptions, (e, p) => {
    const k = c.oneOf(`${p}.kind`, e.kind, ['noBuild', 'fixed', 'style']);
    if (k === 'noBuild') { const poly = c.pts(`${p}.poly`, e.poly, LIMITS.zonePts, 3); if (poly) checkPoly(c, `${p}.poly`, poly); }
    if (k === 'fixed') { c.ref(`${p}.target`, e.target, buildings, '건물'); c.num(`${p}.x`, e.x, -RANGES.coord, RANGES.coord); c.num(`${p}.z`, e.z, -RANGES.coord, RANGES.coord); }
    if (k === 'style') { c.ref(`${p}.target`, e.target, buildings, '건물'); c.oneOf(`${p}.style`, e.style, BUILDING_STYLES); }
  });
}
function checkTerrain(c: Ctx, v: unknown, roads: Map<string, Obj>) {
  if (!isObj(v)) { c.err('terrain', v === undefined ? 'missing' : 'not-object', '지형 정의가 필요합니다'); return; }
  const g = v.grid;
  if (!isObj(g)) { c.err('terrain.grid', 'missing', '높이 격자 정의가 필요합니다'); return; }
  const cell = c.num('terrain.grid.cell', g.cell, 0.5, 100);
  if (cell !== undefined && cell !== RANGES.cell) c.err('terrain.grid.cell', 'range', `현재 격자 간격은 ${RANGES.cell}m 로 고정입니다`);
  c.num('terrain.grid.x0', g.x0, -RANGES.coord, RANGES.coord); c.num('terrain.grid.z0', g.z0, -RANGES.coord, RANGES.coord);
  const cols = c.int('terrain.grid.cols', g.cols, 1, 4000), rows = c.int('terrain.grid.rows', g.rows, 1, 4000);
  if (cols !== undefined && rows !== undefined && cols * rows > 2_000_000) c.err('terrain.grid', 'too-many', '격자 칸 수가 200만을 넘었습니다');
  c.oneOf('terrain.grid.encoding', g.encoding, ['delta-cm-b64']);
  if (typeof g.data !== 'string' && typeof g.ref !== 'string') c.err('terrain.grid', 'missing', 'data(인라인) 또는 ref(파일) 중 하나가 필요합니다');
  c.coll('terrain.edits', v.edits, LIMITS.terrainEdits, (e, p) => {
    const k = c.oneOf(`${p}.kind`, e.kind, ['pad', 'corridor', 'brush']);
    // 선택 필드 warp(pad·brush): 시드 기반 윤곽 비틀림
    if ((k === 'pad' || k === 'brush') && e.warp !== undefined) {
      const w = e.warp as Record<string, unknown> | null;
      if (!w || typeof w !== 'object') c.err(`${p}.warp`, 'type', 'warp 는 {amp, lambda, seed} 객체여야 합니다');
      else { c.num(`${p}.warp.amp`, w.amp, 0, 0.9); c.num(`${p}.warp.lambda`, w.lambda, 10, 1000); c.int(`${p}.warp.seed`, w.seed, 0, 2147483647); }
    }
    if (k === 'pad') {
      c.num(`${p}.x`, e.x, -RANGES.coord, RANGES.coord); c.num(`${p}.z`, e.z, -RANGES.coord, RANGES.coord);
      const r = c.num(`${p}.r`, e.r, 0, RANGES.flatten[1]); if (r !== undefined && r <= 0) c.err(`${p}.r`, 'bad-width', '반경은 0 보다 커야 합니다');
      c.num(`${p}.y`, e.y, -RANGES.height, RANGES.height, false); c.num(`${p}.falloff`, e.falloff, 0, 200);
    } else if (k === 'corridor') {
      c.ref(`${p}.roadId`, e.roadId, roads, '도로');
      c.num(`${p}.cut`, e.cut, 0, 50); c.num(`${p}.fill`, e.fill, 0, 50); c.num(`${p}.shoulder`, e.shoulder, 0, 100);
    } else if (k === 'brush') {
      c.oneOf(`${p}.mode`, e.mode, ['raise', 'lower', 'flatten', 'smooth']);
      const r = c.num(`${p}.r`, e.r, 0, 200); if (r !== undefined && r <= 0) c.err(`${p}.r`, 'bad-width', '반경은 0 보다 커야 합니다');
      c.num(`${p}.strength`, e.strength, 0, 1); c.pts(`${p}.pts`, e.pts, LIMITS.strokePts, 1);
    }
  });
}

/** 원본 전체 검증. 첫 오류에서 멈추지 않고 최대 200개까지 모은다 */
export function validateCitySource(raw: unknown): ValidationResult {
  const c = new Ctx();
  if (!isObj(raw)) { c.err('', 'not-object', '최상위가 객체가 아닙니다'); return {ok: false, errors: c.errors}; }
  const ver = raw.schemaVersion;
  if (typeof ver !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.includes(ver)) {
    c.err('schemaVersion', 'unsupported-version', `지원하지 않는 스키마 버전: ${String(ver)} (지원: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`);
    return {ok: false, errors: c.errors};
  }
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 40)) c.err('name', 'type', '도시 이름은 40자 이하 문자열이어야 합니다');
  c.int('cityRevision', raw.cityRevision, 0, 1e9); c.int('generatorVersion', raw.generatorVersion, 0, 1e9); c.int('seed', raw.seed, 0, LIMITS.seedMax);
  const bounds = c.pts('bounds', raw.bounds, LIMITS.boundsPts, 3);
  if (bounds) checkPoly(c, 'bounds', bounds);
  const lens = new Map<string, number>();
  const roads = checkRoads(c, raw, lens);
  checkTerrain(c, raw.terrain, roads);
  const nodes = checkNodes(c, raw, roads);
  const zones = checkZones(c, raw);
  const parcels = checkParcels(c, raw, roads, lens, zones);
  const buildings = checkBuildings(c, raw, parcels);
  checkRest(c, raw, roads, zones, buildings, nodes);
  if (isObj(raw.facilities)) validatePort(c, raw.facilities.port);
  else if (raw.facilities !== undefined) c.err('facilities', 'not-object', '시설 정의는 객체여야 합니다');
  return {ok: c.errors.length === 0, errors: c.errors};
}
