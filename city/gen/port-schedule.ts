// 물류 항구의 결정적 시간표·크레인 사이클·트럭 경로 (순수 계산: three/DOM/게임 상태 없음, 같은 시각 → 같은 결과).
// 시각 t 는 게임 시계의 하루 주기 안 초(0 ~ periodSec). 렌더(render/citygen/port*.ts)와 시험이 같은 함수를 쓴다.
// 컨테이너는 "교환" 모델로 보존된다: 크레인 한 사이클 = 선박 칸 맨 윗 컨테이너 X 를 내려 트럭 U 로 야적 교환 지점 S 에 보내고,
//   S 에 있던 컨테이너 s 를 트럭 L 로 받아 같은 칸에 올린다 → 상태는 swap(top[k], s) 하나뿐이라 잃거나 복제되지 않는다.
import type {PortBerth, PortCrane, PortShip, PortSource} from '../city-schema.js';

export const CONT = {len: 12, wid: 2.4, hgt: 2.6};
/** 컨테이너선 만재 건현(수면 → 갑판) */
export const FREEBOARD = 5.5;
export const TRUCK_V = 9;
const RAD = Math.PI / 180;
export const BAY_PITCH = 12.4;
export const ROW_PITCH = 2.55;
/** 크레인 사이클 키프레임 시각(기본 90s 를 craneCycleSec 에 맞춰 늘이거나 줄인다) */
const K = {gantry: 8, lowered: 14, lock: 16, lifted: 22, lane: 30, onTruck: 35, release: 37, up: 42, toL: 50, downL: 55, lockL: 57, upL: 62, back: 72, place: 78, done: 80, rest: 86, base: 90};
/** 트럭 L 의 정지 위치를 U 보다 레인 접속점 쪽으로 이만큼 당긴다 */
export const L_OFFSET = 13;
/** 교환 지점 앞뒤로 두 트럭이 서는 거리 */
const S_GAP = 6.5;

export const ease = (u: number): number => { const c = Math.min(1, Math.max(0, u)); return c * c * (3 - 2 * c); };
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mod = (a: number, n: number) => ((a % n) + n) % n;
/** 각도(도) 보간: 최단 호 */
export function lerpAngle(a: number, b: number, t: number): number { const d = mod(b - a + 170, 360) - 170; return a + d * t; } // 범위 [-170,190): 정반대(180°)도 항상 같은 방향으로 돈다
export function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ───────── 경로 ─────────
export interface Path { xs: number[]; zs: number[]; cum: number[]; len: number }
export function polyPath(pts: readonly (readonly number[])[]): Path {
  const xs: number[] = [], zs: number[] = [], cum: number[] = [];
  let s = 0;
  pts.forEach((p, i) => { if (i) s += Math.hypot(p[0] - xs[i - 1], p[1] - zs[i - 1]); xs.push(p[0]); zs.push(p[1]); cum.push(s); });
  return {xs, zs, cum, len: s};
}
/** 제어점을 지나는 Catmull-Rom 을 촘촘히 표본한 경로 */
export function smoothPath(pts: readonly (readonly number[])[], per = 12): Path {
  const P = pts.map(p => [p[0], p[1]]), out: number[][] = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(a => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)));
    }
  }
  out.push(P[P.length - 1]);
  return polyPath(out);
}
export interface PathPt { x: number; z: number; hdg: number }
export function pathAt(p: Path, s: number): PathPt {
  const c = Math.min(p.len, Math.max(0, s));
  let lo = 0, hi = p.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.cum[m] <= c) lo = m; else hi = m; }
  const a = lo, b = Math.min(a + 1, p.cum.length - 1), seg = p.cum[b] - p.cum[a] || 1, t = (c - p.cum[a]) / seg;
  return {x: lerp(p.xs[a], p.xs[b], t), z: lerp(p.zs[a], p.zs[b], t), hdg: Math.atan2(p.zs[b] - p.zs[a], p.xs[b] - p.xs[a]) / RAD};
}

// ───────── 모델 ─────────
export interface ShipM {
  i: number; src: PortShip; berth: PortBerth; route: Path; hold: number;
  slots: number;
  /** 칸 j(bay*rows+row) 의 초기 적재 단수 */
  h0: number[];
  /** 초기 컨테이너 id: id0[j][t] */
  id0: number[][];
  cranes: number[];
}
export interface CraneM {
  i: number; src: PortCrane; ship: number;
  boom: [number, number]; rail: [number, number];
  /** 작업 칸 순서(적재 단수 ≥ 1 인 칸만) */
  order: number[];
  /** 교환 컨테이너 S: 위치·방향, 초기 id */
  swap: {x: number; z: number; rot: number; id0: number};
  /** 트럭 U/L 의 야적 쪽 정지점과 레인 접속점의 레일 좌표 */
  uStart: [number, number]; lStart: [number, number]; approach: [number, number][]; sJ: number;
  cache: {n: number; tops: number[]; s: number} | null;
}
export interface PortModel { src: PortSource; ships: ShipM[]; cranes: CraneM[]; T: number; period: number; }

export function slotLocal(ship: PortShip, j: number): {lx: number; lz: number} {
  const b = Math.floor(j / ship.rows), r = j % ship.rows;
  return {lx: -ship.length / 2 + ship.length * 0.24 + 6 + b * BAY_PITCH, lz: (r - (ship.rows - 1) / 2) * ROW_PITCH};
}
export function toWorld(cx: number, cz: number, headingDeg: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(headingDeg * RAD), s = Math.sin(headingDeg * RAD);
  return [cx + lx * c - lz * s, cz + lx * s + lz * c];
}
/** 칸 j 의 월드 위치(도킹 자세) */
export const slotWorld = (m: PortModel, si: number, j: number): [number, number] => {
  const sh = m.ships[si], l = slotLocal(sh.src, j);
  return toWorld(sh.berth.x, sh.berth.z, sh.berth.heading, l.lx, l.lz);
};

export function buildModel(src: PortSource): PortModel {
  const T = src.schedule.craneCycleSec, berths = new Map(src.berths.map(b => [b.id, b]));
  const ships: ShipM[] = src.ships.map((s, i) => {
    const r = rng(src.schedule.seed * 31 + i * 977 + 7), slots = s.bays * s.rows, h0: number[] = [], id0: number[][] = [];
    for (let j = 0; j < slots; j++) {
      const h = r() < 0.92 ? 1 + Math.floor(r() * s.tiers) : 0;
      h0.push(Math.min(h, s.tiers)); id0.push(Array.from({length: h0[j]}, (_, t) => (i + 1) * 1000 + j * 10 + t));
    }
    const route = src.routes.find(q => q.id === s.route)!, hold = (route as {hold?: number}).hold ?? 70;
    return {i, src: s, berth: berths.get(s.berth)!, route: smoothPath(route.pts, 14), hold, slots, h0, id0, cranes: []};
  });
  const shipIdx = new Map(src.ships.map((s, i) => [s.berth, i]));
  const cranes: CraneM[] = src.cranes.map((c, i) => {
    const si = shipIdx.get(c.berth) ?? 0, a = c.boom * RAD, boom: [number, number] = [Math.cos(a), Math.sin(a)], rail: [number, number] = [-boom[1], boom[0]];
    ships[si]?.cranes.push(i);
    const ap = c.approach, d0 = [ap[1][0] - ap[0][0], ap[1][1] - ap[0][1]], dl = Math.hypot(d0[0], d0[1]) || 1, u = [d0[0] / dl, d0[1] / dl];
    const st = ap[0], side = c.swapSide, nrm = [-u[1] * side, u[0] * side];
    const swap = {x: st[0] + nrm[0] * 3.4, z: st[1] + nrm[1] * 3.4, rot: Math.atan2(u[1], u[0]) / RAD, id0: 9000 + i};
    const J = ap[ap.length - 1], sJ = (J[0] - c.x) * rail[0] + (J[1] - c.z) * rail[1];
    const order: number[] = [];
    for (let j = c.slots[0]; j <= c.slots[1] && ships[si]; j++) if (ships[si].h0[j] > 0) order.push(j);
    return {i, src: c, ship: si, boom, rail, order, swap, uStart: [st[0] - u[0] * S_GAP, st[1] - u[1] * S_GAP], lStart: [st[0] + u[0] * S_GAP, st[1] + u[1] * S_GAP], approach: ap.map(p => [p[0], p[1]] as [number, number]), sJ, cache: null};
  });
  return {src, ships, cranes, T, period: src.schedule.periodSec};
}

// ───────── 게임 시계 → 하루 주기 초 ─────────
export const DAY_S = 720, NIGHT_S = 240;
/** G.cycT(낮 경과)와 G.night(남은 밤)에서 하루 주기 안 시각(0~960). 낮이면 cycT, 밤이면 DAY_S + 밤 경과 */
export const portClock = (cycT: number, nightLeft: number): number => (nightLeft > 0 ? DAY_S + (NIGHT_S - nightLeft) : Math.min(DAY_S, cycT));

// ───────── 선박 ─────────
export type ShipPhase = 'away' | 'arriving' | 'settling' | 'working' | 'unmooring' | 'leaving';
export interface ShipS { phase: ShipPhase; x: number; z: number; heading: number; present: boolean; docked: boolean; /** 하역 시작 후 경과(s), working 일 때만 */ tWork: number; /** 트랩 0~1 */ gang: number; /** 하역 사이클 수(끝났으면 전체) */ cycles: number }
export function shipState(m: PortModel, i: number, t: number): ShipS {
  const sh = m.ships[i], sc = m.src.schedule, P = sc.periodSec, sail = sc.sailSec, st = sc.settleSec, dwell = sh.src.dwell;
  const s = mod(t - sh.src.arriveAt, P), b = sh.berth, L = sh.route.len, total = Math.floor(dwell / m.T);
  const berthPose = {x: b.x, z: b.z, heading: b.heading};
  const blend = (dist: number, tang: number) => lerpAngle(b.heading, tang, ease((dist - sh.hold) / 100));
  const base: ShipS = {phase: 'away', ...berthPose, present: false, docked: false, tWork: 0, gang: 0, cycles: 0};
  if (s < sail) {
    const u = s / sail, d = L * (1 - (1 - u) * (1 - u)), p = pathAt(sh.route, d);
    return {...base, phase: 'arriving', present: true, x: p.x, z: p.z, heading: blend(L - d, p.hdg)};
  }
  if (s < sail + st) return {...base, phase: 'settling', present: true, docked: true, gang: ease((s - sail) / st)};
  if (s < sail + st + dwell) return {...base, phase: 'working', present: true, docked: true, gang: 1, tWork: s - sail - st, cycles: Math.floor((s - sail - st) / m.T)};
  if (s < sail + 2 * st + dwell) return {...base, phase: 'unmooring', present: true, docked: true, gang: 1 - ease((s - sail - st - dwell) / st), cycles: total};
  if (s < 2 * sail + 2 * st + dwell) {
    const u = (s - sail - 2 * st - dwell) / sail, d = L * u * u, p = pathAt(sh.route, L - d);
    return {...base, phase: 'leaving', present: true, x: p.x, z: p.z, heading: blend(d, p.hdg + 180), cycles: total};
  }
  return {...base, cycles: total};
}
/** 선박이 안벽에 접안해 있는 동안의 [시작, 끝) (하루 주기 안, 끝이 주기를 넘을 수 있다) */
export function dockedSpan(m: PortModel, i: number): [number, number] {
  const sc = m.src.schedule, a = m.ships[i].src.arriveAt + sc.sailSec;
  return [a, a + 2 * sc.settleSec + m.ships[i].src.dwell];
}

// ───────── 컨테이너 교환 상태 ─────────
/** n 번 교환한 뒤의 칸 맨 윗 컨테이너 id(칸마다)와 교환 지점 id. 캐시가 앞서가 있으면 처음부터 다시 */
export function stateAfter(m: PortModel, ci: number, n: number): {tops: number[]; s: number} {
  const c = m.cranes[ci], sh = m.ships[c.ship];
  let cur = c.cache;
  if (!cur || cur.n > n) cur = c.cache = {n: 0, tops: sh.id0.map(a => (a.length ? a[a.length - 1] : -1)), s: c.swap.id0};
  while (cur.n < n && c.order.length) { const k = c.order[cur.n % c.order.length], x = cur.tops[k]; cur.tops[k] = cur.s; cur.s = x; cur.n++; }
  if (!c.order.length) cur.n = n;
  return {tops: cur.tops, s: cur.s};
}

// ───────── 크레인·트럭 ─────────
export interface Veh { x: number; z: number; hdg: number; carry: number; moving: boolean }
export interface CraneFrame {
  active: boolean;
  /** 레일 좌표(크레인 기준점 origin 에서 레일 방향으로) · 트롤리 붐 좌표 · 스프레더 윗면 해발 */
  sc: number; r: number; y: number;
  /** 스프레더가 든 컨테이너 id (-1 없음) */
  carry: number;
  /** 작업 칸 번호와 그 맨 위 컨테이너가 내려가 있는가(허공이면 숨김) */
  slot: number; slotHidden: boolean;
  /** 현재 교환 후 상태: 칸 맨 윗 컨테이너 id 들과 교환 지점 id (-1 = 비어 있음) */
  tops: number[]; swapId: number;
  u: Veh; l: Veh;
}
const truckPath = (c: CraneM, start: [number, number], sTarget: number): Path => {
  const pts: number[][] = [start, ...c.approach.slice(1)];
  const o = c.src, ex = o.x + c.rail[0] * sTarget, ez = o.z + c.rail[1] * sTarget, last = pts[pts.length - 1];
  if (Math.hypot(ex - last[0], ez - last[1]) > 0.5) pts.push([ex, ez]);
  return polyPath(pts);
};
/** 크레인 ci 의 사이클 n 안 시각 f(0~T)의 모습. ship 이 일하지 않으면 대기 자세 */
export function craneFrame(m: PortModel, ci: number, n: number, f: number, active: boolean): CraneFrame {
  const c = m.cranes[ci], sh = m.ships[c.ship], o = c.src, k = m.T / K.base, F = f / k;
  const L = c.order.length, state = stateAfter(m, ci, n), tops0 = state.tops.slice(), s0 = state.s;
  const hover = m.src.deckY + 20, truckTop = m.src.deckY + 1.5 + CONT.hgt;
  const railOf = (j: number) => { const [wx, wz] = slotWorld(m, c.ship, j); return {s: (wx - o.x) * c.rail[0] + (wz - o.z) * c.rail[1], r: (wx - o.x) * c.boom[0] + (wz - o.z) * c.boom[1]}; };
  const topY = (j: number) => m.src.waterY + FREEBOARD + sh.h0[j] * CONT.hgt;
  const idle = (j: number): CraneFrame => {
    const q = railOf(j), u0 = pathAt(truckPath(c, c.uStart, q.s), 0), l0 = pathAt(truckPath(c, c.lStart, q.s), 0);
    return {active: false, sc: q.s, r: q.r, y: hover, carry: -1, slot: j, slotHidden: false, tops: tops0, swapId: s0, u: {x: u0.x, z: u0.z, hdg: u0.hdg, carry: -1, moving: false}, l: {x: l0.x, z: l0.z, hdg: l0.hdg, carry: -1, moving: false}};
  };
  if (!L) return idle(0);
  if (!active) return idle(c.order[0]);
  const j = c.order[n % L], jp = c.order[(n + L - 1) % L], q = railOf(j), qp = n === 0 ? q : railOf(jp);
  const X = tops0[j], Y = s0;
  // 트럭 정지 레일 좌표: U 는 칸 바로 아래, L 은 접속점 쪽으로 L_OFFSET 당긴 곳
  const sU = q.s, sL = q.s + Math.sign(c.sJ - q.s || 1) * L_OFFSET, sLp = qp.s + Math.sign(c.sJ - qp.s || 1) * L_OFFSET;
  const pU = truckPath(c, c.uStart, sU), pL = truckPath(c, c.lStart, sL), pLp = truckPath(c, c.lStart, sLp);
  // 크레인
  let sc = q.s, r = q.r, y = hover, carry = -1;
  if (F < K.gantry) { const w = ease(F / K.gantry); sc = lerp(qp.s, q.s, w); r = lerp(qp.r, q.r, w); }
  else if (F < K.lowered) { y = lerp(hover, topY(j), ease((F - K.gantry) / (K.lowered - K.gantry))); }
  else if (F < K.lock) y = topY(j);
  else if (F < K.lifted) { y = lerp(topY(j), hover, ease((F - K.lock) / (K.lifted - K.lock))); carry = X; }
  else if (F < K.lane) { r = lerp(q.r, 0, ease((F - K.lifted) / (K.lane - K.lifted))); carry = X; }
  else if (F < K.onTruck) { r = 0; y = lerp(hover, truckTop, ease((F - K.lane) / (K.onTruck - K.lane))); carry = X; }
  else if (F < K.release) { r = 0; y = truckTop; carry = X; }
  else if (F < K.up) { r = 0; y = lerp(truckTop, hover, ease((F - K.release) / (K.up - K.release))); }
  else if (F < K.toL) { r = 0; sc = lerp(sU, sL, ease((F - K.up) / (K.toL - K.up))); }
  else if (F < K.downL) { r = 0; sc = sL; y = lerp(hover, truckTop, ease((F - K.toL) / (K.downL - K.toL))); }
  else if (F < K.lockL) { r = 0; sc = sL; y = truckTop; }
  else if (F < K.upL) { r = 0; sc = sL; y = lerp(truckTop, hover, ease((F - K.lockL) / (K.upL - K.lockL))); carry = Y; }
  else if (F < K.back) { const w = ease((F - K.upL) / (K.back - K.upL)); sc = lerp(sL, q.s, w); r = lerp(0, q.r, w); carry = Y; }
  else if (F < K.place) { y = lerp(hover, topY(j), ease((F - K.back) / (K.place - K.back))); carry = Y; }
  else if (F < K.done) { y = topY(j); carry = Y; }
  else { y = lerp(topY(j), hover, ease((F - K.done) / (K.rest - K.done))); }
  if (F >= K.done) { sc = q.s; r = q.r; }
  // 트럭 U: 28 에 칸 아래 도착, 40 에 출발해 교환 지점으로 돌아가 X 를 내려놓는다
  let u: Veh;
  const sec = F; // 시각은 키프레임 단위 F, 속도는 m/F
  const vF = TRUCK_V * k;
  const dU = pU.len / vF;
  const dep = Math.max(0, 28 - dU);
  if (sec < dep) u = {...pick(pU, 0), carry: -1, moving: false};
  else if (sec < 28) u = {...pick(pU, (sec - dep) * vF), carry: -1, moving: true};
  else if (sec < 40) u = {...pick(pU, pU.len), carry: sec >= K.release ? X : -1, moving: false};
  else if (sec < 40 + dU) u = {...pick(pU, pU.len - (sec - 40) * vF), carry: X, moving: true};
  else u = {...pick(pU, 0), carry: -1, moving: false};
  const dropAt = 40 + dU;
  // 트럭 L: 직전 레인 위치에서 교환 지점으로 가 22 에 s 를 싣고 곧 칸 쪽으로 간다
  const dLp = pLp.len / vF, dL = pL.len / vF, depL = Math.max(0, 22 - dLp);
  let l: Veh;
  if (sec < depL) l = {...pick(pLp, pLp.len), carry: -1, moving: false};
  else if (sec < 22) l = {...pick(pLp, pLp.len - (sec - depL) * vF), carry: -1, moving: true};
  else if (sec < 24) l = {...pick(pL, 0), carry: Y, moving: false};
  else if (sec < 24 + dL) l = {...pick(pL, (sec - 24) * vF), carry: Y, moving: true};
  else l = {...pick(pL, pL.len), carry: sec < K.lockL ? Y : -1, moving: false};
  // 교환 지점 S 와 칸 맨 위
  const afterSwap = F >= K.done;
  const nxt = afterSwap ? stateAfter(m, ci, n + 1) : state;
  const tops = afterSwap ? nxt.tops.slice() : tops0;
  const swapId = F < 22 ? Y : F < dropAt ? -1 : X;
  const slotHidden = F >= K.lock && F < K.done;
  return {active: true, sc, r, y, carry, slot: j, slotHidden, tops, swapId, u, l};
}
function pick(p: Path, s: number): {x: number; z: number; hdg: number} { return pathAt(p, s); }
/** 하루 주기 시각 t 에서 크레인 ci 의 상태 (선박이 일하는 동안만 active) */
export function craneAtClock(m: PortModel, ci: number, t: number): CraneFrame {
  const c = m.cranes[ci], st = shipState(m, c.ship, t), active = st.phase === 'working';
  const nn = active ? Math.floor(st.tWork / m.T) : st.cycles;
  return craneFrame(m, ci, nn, active ? st.tWork - nn * m.T : 0, active);
}
