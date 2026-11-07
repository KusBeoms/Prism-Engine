// facilities.port 검증(선택 필드). city-validate.ts 의 Ctx 를 구조적 타입으로만 받아 순환 import 를 피한다.
import {PORT_BUILDING_KINDS, PORT_GUARD_POSTS, PORT_RECT_KINDS, RANGES, SHIP_KINDS} from './city-schema.js';

type Obj = Record<string, unknown>;
export interface PortCtx {
  err(path: string, code: any, msg: string): void;
  num(path: string, v: unknown, lo?: number, hi?: number, required?: boolean): number | undefined;
  int(path: string, v: unknown, lo: number, hi: number, required?: boolean): number | undefined;
  oneOf(path: string, v: unknown, list: readonly string[], required?: boolean): string | undefined;
  pt(path: string, v: unknown): [number, number] | undefined;
  pts(path: string, v: unknown, max: number, min: number): [number, number][] | undefined;
  coll(path: string, v: unknown, max: number, each: (o: Obj, p: string, i: number) => void): Map<string, Obj>;
  ref(path: string, v: unknown, set: Map<string, unknown>, what: string, required?: boolean): void;
}
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const C = RANGES.coord;

/** 사각형 x0<x1, z0<z1 검사 후 반환 */
function rect(c: PortCtx, p: string, o: Obj): [number, number, number, number] | undefined {
  const x0 = c.num(`${p}.x0`, o.x0, -C, C), z0 = c.num(`${p}.z0`, o.z0, -C, C), x1 = c.num(`${p}.x1`, o.x1, -C, C), z1 = c.num(`${p}.z1`, o.z1, -C, C);
  if (x0 === undefined || z0 === undefined || x1 === undefined || z1 === undefined) return undefined;
  if (x1 - x0 < 1 || z1 - z0 < 1) { c.err(p, 'bad-width', '사각형은 x0<x1, z0<z1 이고 한 변이 1m 이상이어야 합니다'); return undefined; }
  return [x0, z0, x1, z1];
}

export function validatePort(c: PortCtx, raw: unknown): void {
  if (raw === undefined) return;
  const P = 'facilities.port';
  if (!isObj(raw)) { c.err(P, 'not-object', '항구 정의는 객체여야 합니다'); return; }
  c.num(`${P}.deckY`, raw.deckY, -100, 100); c.num(`${P}.baseY`, raw.baseY, -200, 100); c.num(`${P}.waterY`, raw.waterY, -100, 100);
  const rects = new Map<string, [number, number, number, number]>();
  const plat = c.coll(`${P}.platforms`, raw.platforms, 32, (o, p) => {
    c.oneOf(`${p}.kind`, o.kind, PORT_RECT_KINDS);
    const r = rect(c, p, o); if (r && typeof o.id === 'string') rects.set(o.id, r);
  });
  const inside = (x: number, z: number) => [...rects.values()].some(r => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]);
  const yard = raw.yard;
  if (!isObj(yard)) c.err(`${P}.yard`, 'missing', '야적장 정의가 필요합니다');
  else {
    c.coll(`${P}.yard.blocks`, yard.blocks, 64, (o, p) => {
      const x0 = c.num(`${p}.x0`, o.x0, -C, C), z0 = c.num(`${p}.z0`, o.z0, -C, C);
      const cols = c.int(`${p}.cols`, o.cols, 1, 40), rows = c.int(`${p}.rows`, o.rows, 1, 40);
      c.int(`${p}.maxTiers`, o.maxTiers, 1, 6); c.num(`${p}.fill`, o.fill, 0, 1);
      if (x0 !== undefined && z0 !== undefined && cols && rows && !(inside(x0, z0) && inside(x0 + cols * 12, z0 + rows * 2.4))) c.err(p, 'range', '적재 칸 격자가 부두 상판 밖으로 나갑니다');
    });
  }
  c.coll(`${P}.buildings`, raw.buildings, 32, (o, p) => { c.oneOf(`${p}.kind`, o.kind, PORT_BUILDING_KINDS); rect(c, p, o); c.num(`${p}.h`, o.h, 2, 60); });
  const gate = raw.gate;
  if (!isObj(gate)) c.err(`${P}.gate`, 'missing', '정문 정의가 필요합니다');
  else { c.num(`${P}.gate.x`, gate.x, -C, C); c.num(`${P}.gate.z`, gate.z, -C, C); c.num(`${P}.gate.outward`, gate.outward, -360, 360); c.num(`${P}.gate.width`, gate.width, 3, 30); }
  const acc = raw.access;
  if (!isObj(acc)) c.err(`${P}.access`, 'missing', '진입 도로 정의가 필요합니다');
  else { c.pts(`${P}.access.pts`, acc.pts, 32, 2); c.num(`${P}.access.width`, acc.width, 3, 40); }
  const routes = c.coll(`${P}.routes`, raw.routes, 16, (o, p) => { c.pts(`${p}.pts`, o.pts, 64, 2); c.num(`${p}.hold`, o.hold, 0, 400, false); });
  const berths = c.coll(`${P}.berths`, raw.berths, 16, (o, p) => {
    c.pt(`${p}.center`, [o.x, o.z]); c.num(`${p}.heading`, o.heading, -360, 360); c.num(`${p}.length`, o.length, 20, 600); c.num(`${p}.beam`, o.beam, 5, 100);
    if (!Array.isArray(o.kinds) || o.kinds.some(k => !(SHIP_KINDS as readonly string[]).includes(k as string))) c.err(`${p}.kinds`, 'bad-enum', `허용값: ${SHIP_KINDS.join(', ')}`);
    c.ref(`${p}.platform`, o.platform, plat, '부두 상판');
  });
  const shipsById = c.coll(`${P}.ships`, raw.ships, 16, (o, p) => {
    c.oneOf(`${p}.kind`, o.kind, SHIP_KINDS); c.ref(`${p}.berth`, o.berth, berths, '선석'); c.ref(`${p}.route`, o.route, routes, '항로');
    const len = c.num(`${p}.length`, o.length, 20, 400), beam = c.num(`${p}.beam`, o.beam, 4, 60); c.num(`${p}.draft`, o.draft, 1, 30);
    c.int(`${p}.bays`, o.bays, 1, 30); c.int(`${p}.rows`, o.rows, 1, 12); c.int(`${p}.tiers`, o.tiers, 1, 8);
    if (typeof o.hull !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(o.hull)) c.err(`${p}.hull`, 'type', '#rrggbb 색이어야 합니다');
    c.num(`${p}.arriveAt`, o.arriveAt, 0, 100000); c.num(`${p}.dwell`, o.dwell, 10, 100000);
    const b = typeof o.berth === 'string' ? berths.get(o.berth) : undefined;
    if (b && len !== undefined && typeof b.length === 'number' && len > b.length) c.err(`${p}.length`, 'range', `선박 길이 ${len} 가 선석 길이 ${b.length} 보다 깁니다`);
    if (b && beam !== undefined && typeof b.beam === 'number' && beam > b.beam) c.err(`${p}.beam`, 'range', `선박 폭 ${beam} 가 선석 허용 폭 ${b.beam} 보다 넓습니다`);
    const r = typeof o.route === 'string' ? routes.get(o.route) : undefined;
    if (b && r && Array.isArray(r.pts) && r.pts.length) {
      const e = r.pts[r.pts.length - 1] as number[];
      if (Math.hypot(e[0] - (b.x as number), e[1] - (b.z as number)) > 1) c.err(`${p}.route`, 'range', '항로의 마지막 점이 선석 중심과 달라요');
    }
  });
  c.coll(`${P}.cranes`, raw.cranes, 16, (o, p) => {
    c.ref(`${p}.berth`, o.berth, berths, '선석'); c.num(`${p}.x`, o.x, -C, C); c.num(`${p}.z`, o.z, -C, C); c.num(`${p}.boom`, o.boom, -360, 360);
    c.num(`${p}.gauge`, o.gauge, 3, 40); c.num(`${p}.outreach`, o.outreach, 5, 80); c.num(`${p}.backreach`, o.backreach, 0, 60); c.num(`${p}.height`, o.height, 8, 80);
    const ap = c.pts(`${p}.approach`, o.approach, 16, 2);
    if (o.swapSide !== 1 && o.swapSide !== -1) c.err(`${p}.swapSide`, 'bad-enum', '1 또는 -1');
    if (ap && !ap.every(q => inside(q[0], q[1]))) c.err(`${p}.approach`, 'range', '트럭 경로가 부두 상판 밖으로 나갑니다');
    if (!Array.isArray(o.slots) || o.slots.length !== 2 || !o.slots.every(n => Number.isInteger(n) && (n as number) >= 0) || (o.slots[0] as number) > (o.slots[1] as number)) c.err(`${p}.slots`, 'type', '[from, to] 정수 두 개(from ≤ to)여야 합니다');
    else {
      const b = typeof o.berth === 'string' ? berths.get(o.berth) : undefined;
      const ship = [...shipsById.values()].find(s => s.berth === (b ? o.berth : undefined));
      if (ship && typeof ship.bays === 'number' && typeof ship.rows === 'number' && (o.slots[1] as number) >= ship.bays * ship.rows) c.err(`${p}.slots`, 'range', `선박 칸 수 ${ship.bays * ship.rows} 를 넘습니다`);
    }
  });
  c.coll(`${P}.guards`, raw.guards, 32, (o, p) => { c.oneOf(`${p}.post`, o.post, PORT_GUARD_POSTS); c.num(`${p}.x`, o.x, -C, C); c.num(`${p}.z`, o.z, -C, C); c.num(`${p}.rot`, o.rot, -360, 360); });
  const s = raw.schedule;
  if (!isObj(s)) c.err(`${P}.schedule`, 'missing', '시간표가 필요합니다');
  else {
    c.int(`${P}.schedule.seed`, s.seed, 0, 2147483647); c.num(`${P}.schedule.periodSec`, s.periodSec, 60, 100000); c.num(`${P}.schedule.sailSec`, s.sailSec, 5, 3600);
    c.num(`${P}.schedule.settleSec`, s.settleSec, 1, 600); c.num(`${P}.schedule.craneCycleSec`, s.craneCycleSec, 20, 600);
    const per = s.periodSec as number;
    if (typeof per === 'number') for (const sh of shipsById.values()) {
      const need = 2 * (s.sailSec as number) + 2 * (s.settleSec as number) + (sh.dwell as number);
      if (Number.isFinite(need) && need > per) c.err(`${P}.ships`, 'range', `선박 ${String(sh.id)} 한 번 입출항(${need}s)이 하루 주기(${per}s)보다 길어요`);
    }
  }
}
