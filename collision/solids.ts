// 충돌체 저장소 (W8 P2-a): 정적 AABB·회전 박스(OBB)·움직이는 AABB 를 16u 해시 격자에 담고, 소유자(ownerId)별로 일괄 제거·교체한다.
// core/terrain.ts 가 이 모듈을 re-export 하므로 기존 호출부(addSolid·addDynSolid·dropDynSolid·solidAt)는 그대로 동작한다.
//
// 정밀도·비용
// - 광역: 모든 충돌체는 AABB(x0..x1, z0..z1)로 격자 칸에 등록된다. OBB 는 회전 사각형을 감싸는 AABB 로 등록한다.
// - 정밀: OBB 는 원 중심을 박스 로컬 좌표로 돌려 "가장 가까운 점까지 거리² < r²" 를 푼다. AABB 와 같은 공식이라 부동소수 오차(~1e-12) 외에 근사가 없다.
//   회전각 0 이면 AABB 와 완전히 같은 결과. 추가 비용은 OBB 후보 1개당 곱셈 약 8회(AABB 의 약 2배)이고, 후보는 칸 안에 든 것뿐이다.
// - 각도 규약: 수학 각(x→z 방향이 양의 방향). 로컬 +x 축 = (cos, sin), 로컬 +z 축 = (−sin, cos) (x,z 평면). three 의 rotation.y = θ 메시와 맞추려면 rotDeg = −θ(도).
// - 층 판정(layerOk)은 AABB/OBB 공통으로 기존과 같다.
export interface Solid {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 높이 층(선택): y(발 높이)가 주어진 질의는 y ∈ [lo − 허용치, hi) 일 때만 막는다. up=true 는 고가 층 전용(난간 등) — y 없는 질의는 무시 */
  lo?: number;
  hi?: number;
  up?: boolean;
  /** 소유자 ID (선택): removeSolidsByOwner / replaceSolids 의 키 */
  owner?: string;
  /** 회전 박스 정보 (선택): 있으면 x0..z1 은 감싸는 AABB 일 뿐이고 정밀 판정은 이 값으로 한다 */
  obb?: {cx: number; cz: number; hx: number; hz: number; c: number; s: number};
}
/** replaceSolids 입력 한 건: AABB 형 또는 OBB 형 */
export type SolidSpec =
  | {x0: number; z0: number; x1: number; z1: number; lo?: number; hi?: number; up?: boolean}
  | {cx: number; cz: number; hx: number; hz: number; rotDeg: number; lo?: number; hi?: number; up?: boolean};

const CELL = 16;
const grid = new Map<string, Solid[]>();
const byOwner = new Map<string, Set<Solid>>();
/** 움직이는 충돌체(세워 둔 차): 등록·제거할 수 있는 AABB. 좌표는 등록 시점에 칸에 박제되므로 등록 후 x0..z1 을 바꾸지 말 것(옮기려면 drop 후 다시 add) */
const dyn = new Set<Solid>();
const dynGrid = new Map<string, Solid[]>();

const cellsOf = (s: Solid, fn: (k: string) => void) => {
  for (let i = Math.floor(s.x0 / CELL); i <= Math.floor(s.x1 / CELL); i++)
    for (let j = Math.floor(s.z0 / CELL); j <= Math.floor(s.z1 / CELL); j++) fn(i + ',' + j);
};
const put = (g: Map<string, Solid[]>, k: string, s: Solid) => {
  const a = g.get(k);
  a ? a.push(s) : g.set(k, [s]);
};
/** 칸에서 s 한 건만 빼고, 비면 칸 자체를 지운다 (누수 방지) */
const take = (g: Map<string, Solid[]>, k: string, s: Solid) => {
  const a = g.get(k);
  if (!a) return;
  const i = a.indexOf(s);
  if (i >= 0) a.splice(i, 1);
  if (!a.length) g.delete(k);
};

function register(s: Solid, owner?: string): Solid {
  if (owner !== undefined) {
    s.owner = owner;
    (byOwner.get(owner) || byOwner.set(owner, new Set()).get(owner)!).add(s);
  }
  cellsOf(s, k => put(grid, k, s));
  return s;
}
function make(x0: number, z0: number, x1: number, z1: number, lo?: number, hi?: number, up?: boolean): Solid {
  const s: Solid = {x0, z0, x1, z1};
  if (up) s.up = true;
  if (lo !== undefined) s.lo = lo;
  if (hi !== undefined) s.hi = hi;
  return s;
}
function makeObb(cx: number, cz: number, hx: number, hz: number, rotDeg: number, lo?: number, hi?: number, up?: boolean): Solid {
  const a = (rotDeg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a),
    ex = Math.abs(c) * hx + Math.abs(s) * hz, // 회전 사각형을 감싸는 AABB 의 반폭
    ez = Math.abs(s) * hx + Math.abs(c) * hz;
  const o = make(cx - ex, cz - ez, cx + ex, cz + ez, lo, hi, up);
  o.obb = {cx, cz, hx, hz, c, s};
  return o;
}

/** 정적 AABB 등록. 반환값은 removeSolid 에 넘길 수 있는 핸들 (기존 호출부는 반환값을 무시해도 된다) */
export const addSolid = (x0: number, z0: number, x1: number, z1: number, lo?: number, hi?: number, up?: boolean, ownerId?: string): Solid =>
  register(make(x0, z0, x1, z1, lo, hi, up), ownerId);
/** 정적 회전 박스 등록: 중심(cx,cz), 로컬 반폭(hx,hz), 회전 rotDeg(도). 층 인자는 addSolid 와 같다 */
export const addSolidOBB = (cx: number, cz: number, hx: number, hz: number, rotDeg: number, lo?: number, hi?: number, up?: boolean, ownerId?: string): Solid =>
  register(makeObb(cx, cz, hx, hz, rotDeg, lo, hi, up), ownerId);

/** 핸들 하나 제거. 이미 없으면 false */
export function removeSolid(s: Solid): boolean {
  let found = false;
  cellsOf(s, k => {
    const a = grid.get(k);
    if (a && a.includes(s)) found = true;
    take(grid, k, s);
  });
  if (s.owner !== undefined) {
    const set = byOwner.get(s.owner);
    if (set) (set.delete(s), set.size || byOwner.delete(s.owner));
  }
  return found;
}
/** 소유자의 모든 정적 충돌체 제거. 제거한 개수 반환 */
export function removeSolidsByOwner(ownerId: string): number {
  const set = byOwner.get(ownerId);
  if (!set) return 0;
  const list = [...set];
  list.forEach(removeSolid);
  return list.length;
}
/** 소유자의 충돌체를 통째로 교체. 새것을 먼저 등록한 뒤 옛것을 지운다 — 동기 호출이라 다른 코드(프레임)가 중간 상태를 볼 수 없고, 어느 한 순간도 "둘 다 없음"은 없다 */
export function replaceSolids(ownerId: string, list: readonly SolidSpec[]): Solid[] {
  const old = [...(byOwner.get(ownerId) ?? [])];
  const fresh = list.map(d =>
    'rotDeg' in d
      ? register(makeObb(d.cx, d.cz, d.hx, d.hz, d.rotDeg, d.lo, d.hi, d.up), ownerId)
      : register(make(d.x0, d.z0, d.x1, d.z1, d.lo, d.hi, d.up), ownerId),
  );
  old.forEach(removeSolid);
  return fresh;
}
/** 테스트·진단용: 소유자별 충돌체 목록 / 소유자 ID 목록 / 정적 충돌체 총수 / 격자 칸 항목 총수 / 격자 칸 수 */
export const solidsOwnedBy = (ownerId: string): readonly Solid[] => [...(byOwner.get(ownerId) ?? [])];
export const solidOwners = (): string[] => [...byOwner.keys()];
export const solidCount = (): number => {
  const all = new Set<Solid>();
  grid.forEach(a => a.forEach(s => all.add(s)));
  return all.size;
};
export const solidCellEntries = (): number => {
  let n = 0;
  grid.forEach(a => (n += a.length));
  return n;
};
export const solidCellCount = (): number => grid.size;

/** 움직이는 충돌체(AABB). 해시 격자에 등록하여 solidAt 이 근처 것만 훑는다 */
export const addDynSolid = (x0: number, z0: number, x1: number, z1: number): Solid => {
  const s = {x0, z0, x1, z1};
  dyn.add(s);
  cellsOf(s, k => put(dynGrid, k, s));
  return s;
};
export const dropDynSolid = (s: Solid | null) => {
  if (!s || !dyn.delete(s)) return false;
  cellsOf(s, k => take(dynGrid, k, s));
  return true;
};
export const dynSolidCount = (): number => dyn.size;
export const dynCellEntries = (): number => {
  let n = 0;
  dynGrid.forEach(a => (n += a.length));
  return n;
};
/** 기준 구현(선형 훑기): 해시 격자 결과와 같아야 한다 — 테스트 전용 */
export const dynHitLinear = (x: number, z: number, r: number, y?: number): boolean => {
  for (const d of dyn) if (hitSolid(d, x, z, r, y)) return true;
  return false;
};

/** 높이 층 판정: y 없으면 지상(lo 없는 것)만, y 있으면 [lo−허용치, hi) */
const layerOk = (s: Solid, y?: number) =>
  y === undefined ? !s.up : y >= (s.lo ?? -Infinity) - 1.4 && y < (s.hi ?? Infinity);
/** 반지름 r 인 원과 충돌체 하나의 겹침 (AABB 또는 OBB) */
export function hitSolid(s: Solid, x: number, z: number, r: number, y?: number): boolean {
  if (!layerOk(s, y)) return false;
  const o = s.obb;
  let dx: number, dz: number;
  if (o) {
    const rx = x - o.cx,
      rz = z - o.cz,
      lx = Math.abs(rx * o.c + rz * o.s), // 박스 로컬 좌표
      lz = Math.abs(-rx * o.s + rz * o.c);
    dx = Math.max(lx - o.hx, 0);
    dz = Math.max(lz - o.hz, 0);
  } else {
    dx = x - Math.max(s.x0, Math.min(x, s.x1));
    dz = z - Math.max(s.z0, Math.min(z, s.z1));
  }
  return dx * dx + dz * dz < r * r;
}
/** 원(x,z,r[,y])이 등록된 정적·동적 충돌체와 겹치는가 (방 안 처리는 terrain.solidAt 이 먼저 한다) */
export function hitAny(x: number, z: number, r: number, y?: number): boolean {
  const i0 = Math.floor((x - r) / CELL),
    i1 = Math.floor((x + r) / CELL),
    j0 = Math.floor((z - r) / CELL),
    j1 = Math.floor((z + r) / CELL);
  return (dyn.size > 0 && scan(dynGrid, i0, i1, j0, j1, x, z, r, y)) || scan(grid, i0, i1, j0, j1, x, z, r, y);
}
function scan(g: Map<string, Solid[]>, i0: number, i1: number, j0: number, j1: number, x: number, z: number, r: number, y?: number): boolean {
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const a = g.get(i + ',' + j);
      if (a) for (const s of a) if (hitSolid(s, x, z, r, y)) return true;
    }
  return false;
}
