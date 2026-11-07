// 로우폴리 프리미티브. 전부 비인덱스(면마다 정점 분리) + 정점색이고, computeVertexNormals 가 면 법선을 만든다
// → MeshLambertMaterial(r128 은 flatShading 미지원) 에서도 각진 면 셰이딩이 나온다.
// 공통 인자: (…치수, color, x, y, z, ry). 바닥면이 y 에 놓이고(ico 만 중심), ry 는 Y축 회전(라디안)
import {mix, rgb} from './palette.js';
import {hash2} from './rng.js';

export type Geo = any;
type Pt = readonly [number, number, number];
type XZ = readonly [number, number];

/** 삼각형 수프. 넓이 0 삼각형은 버려서 꼭짓점이 합쳐진 모양(콘·박공)이 낭비 없이 나온다 */
class Soup {
  pos: number[] = [];

  tri(a: Pt, b: Pt, c: Pt) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-10) return;
    this.pos.push(...a, ...b, ...c);
  }

  quad(a: Pt, b: Pt, c: Pt, d: Pt) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
}

/** 수프 → 색칠·회전·이동한 BufferGeometry (sy: 세로 스케일) */
function build(s: Soup, color: number, x: number, y: number, z: number, ry: number, sy = 1): Geo {
  const p = s.pos,
    out = new Float32Array(p.length),
    col = new Float32Array(p.length),
    [r, g, b] = rgb(color),
    c = Math.cos(ry),
    n = Math.sin(ry);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] * c + p[i + 2] * n + x;
    out[i + 1] = p[i + 1] * sy + y;
    out[i + 2] = -p[i] * n + p[i + 2] * c + z;
    col[i] = r;
    col[i + 1] = g;
    col[i + 2] = b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** 위에서 봐서 반시계 방향인 n각형 고리 */
const ngon = (n: number, r: number): XZ[] =>
  Array.from({length: n}, (_, i) => [r * Math.cos((i / n) * Math.PI * 2), -r * Math.sin((i / n) * Math.PI * 2)]);
/** 같은 방향의 직사각형 고리(4점) */
const rect = (w: number, d: number): XZ[] => [[w / 2, -d / 2], [-w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]];

/** 아래 고리 → 위 고리(높이 h) 옆면 + 윗면/아랫면 부채꼴 */
function loft(bottom: XZ[], top: XZ[], h: number): Soup {
  const s = new Soup(),
    n = bottom.length,
    B = (i: number): Pt => [bottom[i % n][0], 0, bottom[i % n][1]],
    T = (i: number): Pt => [top[i % n][0], h, top[i % n][1]];
  for (let i = 0; i < n; i++) s.quad(B(i), B(i + 1), T(i + 1), T(i));
  for (let i = 1; i < n - 1; i++) {
    s.tri(T(0), T(i), T(i + 1));
    s.tri(B(0), B(i + 1), B(i));
  }
  return s;
}

/** 직육면체 (12 tris) */
export const box = (w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, ry = 0): Geo =>
  build(loft(rect(w, d), rect(w, d), h), color, x, y, z, ry);

/** 위아래 크기가 다른 사각 기둥 (12 tris). 위 크기 0 이면 사각뿔 */
export const taper = (wb: number, db: number, wt: number, dt: number, h: number, color: number, x = 0, y = 0, z = 0, ry = 0): Geo =>
  build(loft(rect(wb, db), rect(wt, dt), h), color, x, y, z, ry);

/** 박공 지붕: 능선이 z 방향, 아래 폭 w (8 tris) */
export const gable = (w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, ry = 0): Geo =>
  build(loft(rect(w, d), rect(0, d), h), color, x, y, z, ry);

/** n각 기둥 (4n-4 tris) */
export const prism = (n: number, r: number, h: number, color: number, x = 0, y = 0, z = 0, ry = 0): Geo =>
  build(loft(ngon(n, r), ngon(n, r), h), color, x, y, z, ry);

/** 원기둥 = 세그먼트 6~10 의 n각 기둥 (기본 8) */
export const cyl = (r: number, h: number, color: number, x = 0, y = 0, z = 0, ry = 0, seg = 8): Geo =>
  prism(seg, r, h, color, x, y, z, ry);

/** 위가 좁아지는 기둥 / 꼭대기가 뾰족한 콘 (rt=0, 세그 n 이면 2n-2 tris) */
export const frustum = (n: number, rb: number, rt: number, h: number, color: number, x = 0, y = 0, z = 0, ry = 0): Geo =>
  build(loft(ngon(n, rb), ngon(n, rt), h), color, x, y, z, ry);
export const cone = (r: number, h: number, color: number, x = 0, y = 0, z = 0, ry = 0, seg = 8): Geo =>
  frustum(seg, r, 0, h, color, x, y, z, ry);

/** 경사로: 앞(+z)이 높이 0, 뒤(-z)가 높이 h (8 tris) */
export function wedge(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, ry = 0): Geo {
  const s = new Soup(),
    hw = w / 2,
    hd = d / 2,
    a: Pt = [-hw, 0, hd], b: Pt = [hw, 0, hd], c: Pt = [hw, 0, -hd], e: Pt = [-hw, 0, -hd],
    f: Pt = [hw, h, -hd], g: Pt = [-hw, h, -hd];
  s.quad(a, e, c, b);
  s.quad(a, b, f, g);
  s.quad(c, e, g, f);
  s.tri(b, c, f);
  s.tri(a, g, e);
  return build(s, color, x, y, z, ry);
}

/** 한 면짜리 판(+z 를 향함, 2 tris). 창문·간판처럼 두께가 필요 없을 때. y 는 판 중심 */
export function panel(w: number, h: number, color: number, x = 0, y = 0, z = 0, ry = 0): Geo {
  const s = new Soup();
  s.quad([-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]);
  return build(s, color, x, y, z, ry);
}

/** 이코스피어: r128 에서 detail 0/1/2/3 = 20/80/180/320 tris. 중심이 (x,y,z), sy 로 납작하게(바위) */
export function ico(r: number, detail: number, color: number, x = 0, y = 0, z = 0, ry = 0, sy = 1): Geo {
  const src = new THREE.IcosahedronGeometry(r, detail).toNonIndexed(),
    s = new Soup(),
    p = src.attributes.position.array as Float32Array;
  src.dispose();
  for (let i = 0; i < p.length; i += 9) {
    s.tri([p[i], p[i + 1], p[i + 2]], [p[i + 3], p[i + 4], p[i + 5]], [p[i + 6], p[i + 7], p[i + 8]]);
  }
  return build(s, color, x, y, z, ry, sy);
}

/** 정점을 시드 해시로 ±amp 흔든다(같은 모서리는 같이 움직여 틈이 안 생김). 바위·수관용 */
export function wobble(geo: Geo, amp: number, seed = 0): Geo {
  const p = geo.attributes.position,
    q = (v: number) => Math.round(v * 64);
  for (let i = 0; i < p.count; i++) {
    const kx = q(p.getX(i)), ky = q(p.getY(i)), kz = q(p.getZ(i));
    p.setXYZ(
      i,
      p.getX(i) + (hash2(kx, ky * 31 + kz, seed) - 0.5) * 2 * amp,
      p.getY(i) + (hash2(ky, kz * 31 + kx, seed + 1) - 0.5) * 2 * amp,
      p.getZ(i) + (hash2(kz, kx * 31 + ky, seed + 2) - 0.5) * 2 * amp,
    );
  }
  geo.computeVertexNormals();
  return geo;
}

/** 삼각형마다 밝기를 ±amp 흔들어 손으로 칠한 느낌을 낸다 */
export function speckle(geo: Geo, amp: number, seed = 0): Geo {
  const c = geo.attributes.color;
  for (let t = 0; t < c.count; t += 3) {
    const k = 1 + (hash2(t, seed, 7) - 0.5) * 2 * amp;
    for (let i = t; i < t + 3; i++) c.setXYZ(i, Math.min(1, c.getX(i) * k), Math.min(1, c.getY(i) * k), Math.min(1, c.getZ(i) * k));
  }
  return geo;
}

/** 정점색을 아래(bottom)→위(top) 세로 그라디언트로 다시 칠한다 */
export function gradientY(geo: Geo, bottom: number, top: number): Geo {
  geo.computeBoundingBox();
  const {min, max} = geo.boundingBox,
    p = geo.attributes.position,
    c = geo.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const [r, g, b] = rgb(mix(bottom, top, (p.getY(i) - min.y) / (max.y - min.y || 1)));
    c.setXYZ(i, r, g, b);
  }
  return geo;
}
