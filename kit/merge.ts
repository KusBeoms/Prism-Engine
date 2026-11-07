// 지오메트리 병합(변환·정점색 베이크)과 인스턴싱, 공유 재질, 삼각형 수 계측
import {rgb} from './palette.js';
import type {Geo} from './prim.js';

/** 병합 입력: 지오메트리 + 배치(이동 x,y,z · Y회전 ry · 균등 배율 s) */
export interface Placed {
  g: Geo;
  x?: number;
  y?: number;
  z?: number;
  ry?: number;
  s?: number;
}

/** 배치를 정점에 굽고(위치·법선) 이어 붙여 지오메트리 1개로 만든다 → 드로우콜 1회. 색 없는 입력은 흰색 */
export function mergePlaced(list: Placed[]): Geo {
  const parts = list.map(it => {
    const g = it.g.index ? it.g.toNonIndexed() : it.g;
    if (!g.attributes.normal) g.computeVertexNormals();
    return {...it, g};
  });
  let total = 0;
  parts.forEach(it => (total += it.g.attributes.position.count));
  const pos = new Float32Array(total * 3),
    nor = new Float32Array(total * 3),
    col = new Float32Array(total * 3).fill(1),
    surface = parts.some(it => it.g.attributes.surfaceDetail) ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const {g, x = 0, y = 0, z = 0, ry = 0, s = 1} of parts) {
    const n = g.attributes.position.count,
      p = g.attributes.position.array,
      nm = g.attributes.normal.array,
      cl = g.attributes.color ? g.attributes.color.array : null,
      sd = g.attributes.surfaceDetail ? g.attributes.surfaceDetail.array : null,
      c = Math.cos(ry),
      sn = Math.sin(ry);
    for (let i = 0; i < n * 3; i += 3, o += 3) {
      pos[o] = (p[i] * c + p[i + 2] * sn) * s + x;
      pos[o + 1] = p[i + 1] * s + y;
      pos[o + 2] = (-p[i] * sn + p[i + 2] * c) * s + z;
      nor[o] = nm[i] * c + nm[i + 2] * sn;
      nor[o + 1] = nm[i + 1];
      nor[o + 2] = -nm[i] * sn + nm[i + 2] * c;
      if (surface) {
        surface[o] = sd ? sd[i] : 0;
        surface[o + 1] = sd ? sd[i + 1] : 4;
        surface[o + 2] = sd ? sd[i + 2] : 0;
      }
      if (cl) {
        col[o] = cl[i];
        col[o + 1] = cl[i + 1];
        col[o + 2] = cl[i + 2];
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (surface) out.setAttribute('surfaceDetail', new THREE.BufferAttribute(surface, 3));
  return out;
}

/** 배치 없이 이어 붙이기 */
export const mergeGeometries = (list: Geo[]): Geo => mergePlaced(list.map(g => ({g})));

let lit: any = null,
  glow: any = null;
/** 공유 재질: 조명을 받는 정점색 Lambert. keep=true 라 freeTree 가 해제하지 않는다 */
export function lowMat(): any {
  if (!lit) {
    lit = new THREE.MeshLambertMaterial({vertexColors: true});
    lit.userData.keep = true;
  }
  return lit;
}
/** 공유 재질: 조명을 받지 않는 정점색(창문·네온) */
export function glowMat(): any {
  if (!glow) {
    glow = new THREE.MeshBasicMaterial({vertexColors: true});
    glow.userData.keep = true;
  }
  return glow;
}
/** 공유 지오메트리에 keep 표시 */
export function keep<T extends {userData: any}>(o: T): T {
  o.userData.keep = true;
  return o;
}

/** 인스턴스 1개의 배치. color 가 있으면 정점색에 곱해지는 인스턴스 색 */
export interface Inst {
  x: number;
  y: number;
  z: number;
  ry?: number;
  s?: number;
  color?: number;
}

/** 같은 지오메트리를 여러 번 그리는 InstancedMesh (드로우콜 1회, 컬링은 끔) */
export function instanced(geo: Geo, mat: any, items: Inst[]): any {
  const m = new THREE.InstancedMesh(geo, mat, items.length),
    o = new THREE.Object3D(),
    c = new THREE.Color();
  items.forEach((it, i) => {
    o.position.set(it.x, it.y, it.z);
    o.rotation.y = it.ry ?? 0;
    o.scale.setScalar(it.s ?? 1);
    o.updateMatrix();
    m.setMatrixAt(i, o.matrix);
    if (it.color !== undefined) {
      const [r, g, b] = rgb(it.color);
      m.setColorAt(i, c.setRGB(r, g, b));
    }
  });
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.frustumCulled = false;
  return m;
}

/** 인스턴스를 cell(u) 칸으로 나눠 칸마다 InstancedMesh 를 만들고 칸 단위로 컬링한다(큰 월드의 나무·가로등용). 반환은 Group */
export function instancedChunks(geo: Geo, mat: any, items: Inst[], cell = 96, reach = 6): any {
  const g = new THREE.Group(),
    by = new Map<string, Inst[]>();
  for (const it of items) {
    const k = Math.floor(it.x / cell) + ',' + Math.floor(it.z / cell);
    (by.get(k) || by.set(k, []).get(k)!).push(it);
  }
  by.forEach(list => {
    const m = instanced(geo.clone(), mat, list);
    let cx = 0, cy = 0, cz = 0;
    list.forEach(i => ((cx += i.x), (cy += i.y), (cz += i.z)));
    cx /= list.length; cy /= list.length; cz /= list.length;
    const r = Math.max(...list.map(i => Math.hypot(i.x - cx, i.y - cy, i.z - cz))) + reach * 2;
    m.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r);
    m.frustumCulled = true;
    g.add(m);
  });
  return g;
}

/** 지오메트리 1개의 정점·삼각형 수 */
export function geoStats(g: Geo): {verts: number; tris: number} {
  const verts = g.attributes.position.count;
  return {verts, tris: (g.index ? g.index.count : verts) / 3};
}

/** 객체 트리가 그리는 삼각형 수 (인스턴스는 개수만큼) */
export function countTris(root: any): number {
  let n = 0;
  root.traverse((o: any) => {
    if (o.isMesh) n += geoStats(o.geometry).tris * (o.isInstancedMesh ? o.count : 1);
  });
  return n;
}
