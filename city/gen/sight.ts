// 사과 시선 축 검사: 앵커(기지)의 눈높이에서 정북 ±halfDeg, 고도 elevDeg 의 원뿔을 가리는 높이의 건물·나무를 거른다.
import type {CitySource} from '../city-schema.js';
import {wrapPi} from './geom.js';
import {axesOf} from './obb.js';
import type {Obb} from './obb.js';
import {DEFAULT_SIGHT} from './place-types.js';
import type {PlaceCtx} from './place-ctx.js';
import type {SightAxis} from './place-types.js';

const RAD = Math.PI / 180;
/** 앵커(kind 'base')에서 기본 시선 축을 만든다. 옵션이 우선 */
export function sightAxesOf(src: CitySource, override?: SightAxis[]): SightAxis[] {
  if (override) return override;
  return src.anchors.filter(a => a.kind === 'base').map(a => ({id: a.id, x: a.x, z: a.z, y: a.y, ...DEFAULT_SIGHT}));
}
/** 높이 top(해발) 의 점 (x,z) 이 축을 가리는가 */
export function pointBlocks(ax: SightAxis, eyeY: number, x: number, z: number, top: number): boolean {
  const dx = x - ax.x, dz = z - ax.z, dist = Math.hypot(dx, dz);
  if (dist < 0.5) return false;
  const az = Math.atan2(dx, -dz), diff = Math.abs(wrapPi(az - ax.azimuthDeg * RAD));
  return diff <= ax.halfDeg * RAD && (top - eyeY) / dist > Math.tan(ax.elevDeg * RAD);
}
/** 회전 박스 윗면(top)이 어느 축이든 가리면 해당 축 id, 아니면 null (경계 표본 포함) */
export function sightBlock(ctx: PlaceCtx, axes: SightAxis[], o: Obb, top: number): string | null {
  if (!axes.length) return null;
  const {ax, az} = axesOf(o.rot), nx = Math.max(2, Math.ceil((o.hw * 2) / 2)), nz = Math.max(2, Math.ceil((o.hd * 2) / 2));
  for (const a of axes) {
    const eye = (a.y ?? ctx.groundY(a.x, a.z)) + a.eye;
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
      const lx = -o.hw + (2 * o.hw * i) / nx, lz = -o.hd + (2 * o.hd * j) / nz;
      if (pointBlocks(a, eye, o.cx + ax[0] * lx + az[0] * lz, o.cz + ax[1] * lx + az[1] * lz, top)) return a.id;
    }
  }
  return null;
}
/** 점(나무 꼭대기)이 어느 축이든 가리는가 */
export function treeBlocks(ctx: PlaceCtx, axes: SightAxis[], x: number, z: number, top: number): boolean {
  for (const a of axes) if (pointBlocks(a, (a.y ?? ctx.groundY(a.x, a.z)) + a.eye, x, z, top)) return true;
  return false;
}

/** 시선 축 높이 상한: 박스 발자국이 쐐기(정북 ±halfDeg)에 걸치는 표본마다 해발 상한 = 눈높이 + (z 방향 거리) * tan(고도). 쐐기 밖이면 Infinity.
 *  거리를 z 방향 성분으로 재서 실제 거리 기준보다 약간 보수적이다(tests 의 downtown blocksApple 과 같은 식). */
export function sightCap(ctx: PlaceCtx, axes: SightAxis[], o: Obb): number {
  let cap = Infinity;
  if (!axes.length) return cap;
  const {ax, az} = axesOf(o.rot), nx = Math.max(2, Math.ceil((o.hw * 2) / 1.5)), nz = Math.max(2, Math.ceil((o.hd * 2) / 1.5));
  for (const a of axes) {
    const eye = (a.y ?? ctx.groundY(a.x, a.z)) + a.eye, tn = Math.tan(a.elevDeg * RAD), hw = a.halfDeg * RAD, az0 = a.azimuthDeg * RAD;
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
      const lx = -o.hw + (2 * o.hw * i) / nx, lz = -o.hd + (2 * o.hd * j) / nz;
      const dx = o.cx + ax[0] * lx + az[0] * lz - a.x, dz = o.cz + ax[1] * lx + az[1] * lz - a.z, dist = Math.hypot(dx, dz);
      if (dist < 0.5 || Math.abs(wrapPi(Math.atan2(dx, -dz) - az0)) > hw) continue;
      const along = dist * Math.cos(wrapPi(Math.atan2(dx, -dz) - az0));
      cap = Math.min(cap, eye + along * tn - 0.3);
    }
  }
  return cap;
}
