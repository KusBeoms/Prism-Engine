// 회전 박스(OBB) 도구. 회전 규약은 BuildingSource.rot 와 같다: 로컬 +x → (cosθ, -sinθ), 로컬 +z → (sinθ, cosθ) (x,z 평면, θ 도).
import type {P2} from './geom.js';

export interface Obb { cx: number; cz: number; hw: number; hd: number; rot: number }
const RAD = Math.PI / 180;
export const axesOf = (rot: number): {ax: P2; az: P2} => { const c = Math.cos(rot * RAD), s = Math.sin(rot * RAD); return {ax: [c, -s], az: [s, c]}; };
export function toWorld(o: Obb, lx: number, lz: number): P2 {
  const {ax, az} = axesOf(o.rot);
  return [o.cx + ax[0] * lx + az[0] * lz, o.cz + ax[1] * lx + az[1] * lz];
}
export function toLocal(o: Obb, x: number, z: number): P2 {
  const {ax, az} = axesOf(o.rot), dx = x - o.cx, dz = z - o.cz;
  return [dx * ax[0] + dz * ax[1], dx * az[0] + dz * az[1]];
}
export const corners = (o: Obb): P2[] => [toWorld(o, -o.hw, -o.hd), toWorld(o, o.hw, -o.hd), toWorld(o, o.hw, o.hd), toWorld(o, -o.hw, o.hd)];
export function aabbOf(o: Obb): [number, number, number, number] {
  const {ax, az} = axesOf(o.rot), ex = Math.abs(ax[0]) * o.hw + Math.abs(az[0]) * o.hd, ez = Math.abs(ax[1]) * o.hw + Math.abs(az[1]) * o.hd;
  return [o.cx - ex, o.cz - ez, o.cx + ex, o.cz + ez];
}
/** 점에서 박스까지 거리(안이면 0) */
export function distToObb(o: Obb, x: number, z: number): number {
  const [lx, lz] = toLocal(o, x, z), dx = Math.max(Math.abs(lx) - o.hw, 0), dz = Math.max(Math.abs(lz) - o.hd, 0);
  return Math.hypot(dx, dz);
}
/** 두 박스가 gap 이내로 겹치는가(분리축 정리, gap 만큼 부풀림) */
export function obbOverlap(a: Obb, b: Obb, gap = 0): boolean {
  const A = axesOf(a.rot), B = axesOf(b.rot), dx = b.cx - a.cx, dz = b.cz - a.cz;
  for (const ax of [A.ax, A.az, B.ax, B.az]) {
    const d = Math.abs(dx * ax[0] + dz * ax[1]);
    const ra = a.hw * Math.abs(A.ax[0] * ax[0] + A.ax[1] * ax[1]) + a.hd * Math.abs(A.az[0] * ax[0] + A.az[1] * ax[1]);
    const rb = b.hw * Math.abs(B.ax[0] * ax[0] + B.ax[1] * ax[1]) + b.hd * Math.abs(B.az[0] * ax[0] + B.az[1] * ax[1]);
    if (d > ra + rb + gap) return false;
  }
  return true;
}
/** 선분이 (gap 만큼 부푼) 박스와 만나는가 */
export function segHitsObb(o: Obb, a: P2, b: P2, gap = 0): boolean {
  const p = toLocal(o, a[0], a[1]), q = toLocal(o, b[0], b[1]), hw = o.hw + gap, hd = o.hd + gap;
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dz = q[1] - p[1];
  for (const [d, lo, hi, s] of [[dx, -hw, hw, p[0]], [dz, -hd, hd, p[1]]] as [number, number, number, number][]) {
    if (Math.abs(d) < 1e-12) { if (s < lo || s > hi) return false; continue; }
    let u0 = (lo - s) / d, u1 = (hi - s) / d;
    if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  return true;
}
/** 원이 박스와 겹치는가 */
export const circleHitsObb = (o: Obb, x: number, z: number, r: number): boolean => distToObb(o, x, z) < r;
