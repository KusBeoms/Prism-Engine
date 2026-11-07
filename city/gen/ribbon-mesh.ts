// 리본 메시 누산기: 삼각형/사각형을 (층, 표면, 청크) 버킷에 모은다. 청크 경계에 걸친 삼각형은 경계에서 잘라 각 청크에 정확히 들어가게 한다.
// 정점 = [x,y,z,u,v]. 연속 사각형은 같은 정점 객체를 쓰면 인덱스를 재사용한다(스트립 중복 제거).
import type {RibbonChunk} from '../city-compiled.js';
import {rnd} from './bytes.js';

export type V5 = [number, number, number, number, number];
export type Surface = RibbonChunk['surface'];
export type Orient = 'up' | 'down' | [number, number];
export const SURFACE_ORDER: Surface[] = ['asphalt', 'shoulder', 'median', 'sidewalk', 'curb', 'marking', 'crosswalk', 'deck'];

interface Bucket {
  layer: number; surface: Surface; cx: number; cz: number;
  pos: number[]; uv: number[]; idx: number[];
  /** 값 기준 정점 중복 제거 (방향 태그 + 위치 cm + uv) */
  map: Map<string, number>;
}
export interface MeshStats { vertices: number; triangles: number; bySurface: Record<string, number>; overflow: boolean }

export class MeshSet {
  private buckets = new Map<string, Bucket>();
  private nv = 0; private nt = 0; private bySurface: Record<string, number> = {};
  overflow = false;
  constructor(readonly chunk: number, readonly withUv: boolean, readonly maxVertices: number) {}

  private bucket(layer: number, surface: Surface, cx: number, cz: number): Bucket {
    const k = `${layer}|${surface}|${cx}|${cz}`;
    let b = this.buckets.get(k);
    if (!b) { b = {layer, surface, cx, cz, pos: [], uv: [], idx: [], map: new Map()}; this.buckets.set(k, b); }
    return b;
  }
  private push(b: Bucket, v: V5, tag: string): number {
    const key = `${tag}${Math.round(v[0] * 100)},${Math.round(v[1] * 100)},${Math.round(v[2] * 100)},${this.withUv ? Math.round(v[3] * 10) + ',' + Math.round(v[4] * 10) : ''}`;
    const hit = b.map.get(key);
    if (hit !== undefined) return hit;
    b.pos.push(rnd(v[0]), rnd(v[1]), rnd(v[2]));
    if (this.withUv) b.uv.push(rnd(v[3], 1), rnd(v[4], 1));
    this.nv++;
    this.bySurface[b.surface] = (this.bySurface[b.surface] ?? 0) + 1;
    const i = b.pos.length / 3 - 1;
    b.map.set(key, i);
    return i;
  }
  /** 삼각형 하나. 방향(orient)에 맞춰 감는 순서를 정한다 */
  tri(layer: number, surface: Surface, a: V5, b: V5, c: V5, orient: Orient): void {
    if (this.nv > this.maxVertices) { this.overflow = true; return; }
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dot = orient === 'up' ? ny : orient === 'down' ? -ny : nx * orient[0] + nz * orient[1];
    if (Math.abs(dot) < 1e-12) return; // 퇴화
    if (dot < 0) { const t = b; b = c; c = t; }
    const tag = orient === 'up' ? 'u' : orient === 'down' ? 'd' : 's', cs = this.chunk;
    const x0 = Math.min(a[0], b[0], c[0]), x1 = Math.max(a[0], b[0], c[0]), z0 = Math.min(a[2], b[2], c[2]), z1 = Math.max(a[2], b[2], c[2]);
    const i0 = Math.floor(x0 / cs), i1 = Math.floor(x1 / cs), j0 = Math.floor(z0 / cs), j1 = Math.floor(z1 / cs);
    if (i0 === i1 && j0 === j1) { this.emit(this.bucket(layer, surface, i0, j0), a, b, c, tag); return; }
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      let poly: V5[] = [a, b, c];
      poly = clipAxis(poly, 0, i * cs, true); poly = clipAxis(poly, 0, (i + 1) * cs, false);
      poly = clipAxis(poly, 2, j * cs, true); poly = clipAxis(poly, 2, (j + 1) * cs, false);
      if (poly.length < 3) continue;
      const bk = this.bucket(layer, surface, i, j);
      for (let k = 1; k + 1 < poly.length; k++) {
        const ar = (poly[k][0] - poly[0][0]) * (poly[k + 1][2] - poly[0][2]) - (poly[k + 1][0] - poly[0][0]) * (poly[k][2] - poly[0][2]);
        if (Math.abs(ar) < 1e-9 && Math.abs(poly[k][1] - poly[0][1]) < 1e-9) continue;
        this.emit(bk, poly[0], poly[k], poly[k + 1], tag);
      }
    }
  }
  private emit(b: Bucket, a: V5, c: V5, d: V5, tag: string): void {
    b.idx.push(this.push(b, a, tag), this.push(b, c, tag), this.push(b, d, tag));
    this.nt++;
  }
  /** 스트립 사각형: p0,p1 = 앞 슬라이스(왼쪽,오른쪽), q0,q1 = 뒤 슬라이스 */
  quad(layer: number, surface: Surface, p0: V5, p1: V5, q0: V5, q1: V5, orient: Orient): void {
    this.tri(layer, surface, p0, p1, q0, orient);
    this.tri(layer, surface, p1, q1, q0, orient);
  }
  chunks(): RibbonChunk[] {
    const arr = [...this.buckets.values()].filter(b => b.idx.length > 0);
    arr.sort((a, b) => a.layer - b.layer || SURFACE_ORDER.indexOf(a.surface) - SURFACE_ORDER.indexOf(b.surface) || a.cx - b.cx || a.cz - b.cz);
    return arr.map(b => {
      const o: RibbonChunk = {key: `${b.cx},${b.cz}`, layer: b.layer, surface: b.surface, positions: b.pos, indices: b.idx};
      if (this.withUv) o.uv = b.uv;
      return o;
    });
  }
  stats(): MeshStats { return {vertices: this.nv, triangles: this.nt, bySurface: {...this.bySurface}, overflow: this.overflow}; }
}

/** 다각형을 축(x=0 / z=2)에 수직인 반평면으로 자른다. keepGE=true 면 값 ≥ edge 쪽을 남긴다. 속성은 선형 보간 */
function clipAxis(poly: V5[], axis: 0 | 2, edge: number, keepGE: boolean): V5[] {
  const out: V5[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = keepGE ? a[axis] - edge : edge - a[axis], db = keepGE ? b[axis] - edge : edge - b[axis];
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      const v: V5 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t];
      v[axis] = edge; // 경계 위로 정확히
      out.push(v);
    }
  }
  return out;
}
