// 공용 구조 부품: 선분 보·고리. 정점색만 사용하고 호출부에서 병합한다.
import {box, type Geo} from './prim.js';
export type V3 = readonly [number, number, number];
export function beam(a: V3, b: V3, width: number, color: number, depth = width): Geo {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
  const g = box(width, d.length(), depth, color);
  g.translate(0, -d.length() / 2, 0);
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())));
  g.translate(...A.add(B).multiplyScalar(0.5).toArray());
  return g;
}
export function ring(radius: number, width: number, color: number, x = 0, y = 0, z = 0, tilt = 0, segments = 20): Geo[] {
  const point = (a: number): V3 => [x + Math.cos(a) * radius, y + Math.sin(a) * radius * Math.cos(tilt), z + Math.sin(a) * radius * Math.sin(tilt)];
  return Array.from({length: segments}, (_, i) => beam(point(i * Math.PI * 2 / segments), point((i + 1) * Math.PI * 2 / segments), width, color));
}
