// 갤러리 전시용 샘플(건물·나무·바위·가로등). 시드 → 같은 모양. 정식 건물/소품 문법은 building.ts / props.ts 가 이어받는다
import {CITY, NEUTRAL, PAL} from './palette.js';
import {box, cone, frustum, gable, gradientY, ico, panel, prism, speckle, taper, wobble, type Geo} from './prim.js';
import {mergeGeometries, mergePlaced} from './merge.js';
import {mulberry32, pick, range} from './rng.js';

/** 조명 받는 면(solid) + 조명 무시 면(glow: 창문·전구) */
export interface Part {
  solid: Geo;
  glow?: Geo;
}

const FLOOR = 6; // 문 높이 5u 가 들어가는 층고

/** 문법식 건물: 몸통 + 층 띠 + 지붕(flat/gable/tower) + 문 + 창문 판 */
export function sampleBuilding(seed: number): Part {
  const r = mulberry32(seed),
    w = 4 * Math.round(range(r, 4, 6)),
    d = 4 * Math.round(range(r, 3.5, 5)),
    floors = 2 + Math.floor(r() * 3),
    h = floors * FLOOR,
    wall = pick(r, [CITY.plaster, CITY.brick, NEUTRAL.bone, NEUTRAL.ash]),
    roofC = pick(r, [CITY.tileRed, CITY.tileBlue, NEUTRAL.slate]),
    roof = pick(r, ['flat', 'gable', 'tower'] as const);
  const solid: Geo[] = [box(w, h, d, wall), box(2.4, 0.3, 1.6, CITY.awning, 0, 5, d / 2 + 0.6), panel(4, 5, NEUTRAL.wood, 0, 2.5, d / 2 + 0.05)];
  for (let f = 1; f < floors; f++) solid.push(box(w + 0.4, 0.4, d + 0.4, NEUTRAL.stone, 0, f * FLOOR - 0.2));
  if (roof === 'flat') solid.push(box(w + 0.6, 0.6, d + 0.6, NEUTRAL.slate, 0, h));
  if (roof === 'gable') solid.push(gable(w + 0.8, 3, d + 0.8, roofC, 0, h));
  if (roof === 'tower') solid.push(box(w * 0.6, 3, d * 0.6, wall, 0, h), taper(w * 0.7, d * 0.7, 0, 0, 5, roofC, 0, h + 3));
  const win: Geo[] = [];
  const faces: [number, number, number, number][] = [
    [0, d / 2, 0, w], [0, -d / 2, Math.PI, w], [w / 2, 0, Math.PI / 2, d], [-w / 2, 0, -Math.PI / 2, d],
  ];
  for (let f = 0; f < floors; f++) {
    for (const [x, z, ry, len] of faces) {
      const n = Math.floor(len / 5);
      for (let i = 0; i < n; i++) {
        const s = (i - (n - 1) / 2) * 5;
        if (f === 0 && z > 0 && Math.abs(s) < 3) continue; // 문 자리
        const lit = r() < 0.4 ? PAL.amber : PAL.glass,
          c = Math.cos(ry),
          sn = Math.sin(ry);
        win.push(panel(2, 2.6, lit, x + s * c + 0.05 * sn, f * FLOOR + 3.6, z - s * sn + 0.05 * c, ry));
      }
    }
  }
  return {solid: mergeGeometries(solid), glow: mergeGeometries(win)};
}

/** 나무 3종: 0 소나무, 1 둥근 나무, 2 포플러 (30~60 tris) */
export function sampleTree(kind: 0 | 1 | 2, seed = 1): Part {
  const leaf = [PAL.green, PAL.lime, PAL.teal][kind],
    dark = NEUTRAL.coal,
    trunk = prism(5, kind === 1 ? 0.6 : 0.5, 3, NEUTRAL.wood);
  const parts: Geo[] = [trunk];
  if (kind === 0) {
    [3, 2.3, 1.6].forEach((rad, i) => parts.push(gradientY(cone(rad, 3.6, leaf, 0, 2 + i * 2, 0, 0, 6), dark, leaf)));
  } else if (kind === 1) {
    parts.push(wobble(ico(2.6, 0, leaf, 0, 5, 0), 0.3, seed), wobble(ico(1.9, 0, PAL.lime, 0.8, 6.6, 0.4), 0.3, seed + 1));
  } else {
    parts.push(frustum(6, 1.8, 0.9, 4, leaf, 0, 2.4), cone(1.2, 5, PAL.green, 0, 6, 0, 0, 6));
  }
  return {solid: speckle(mergeGeometries(parts), 0.08, seed)};
}

/** 바위 (20 tris) */
export function sampleRock(seed: number): Part {
  return {solid: speckle(wobble(ico(1.6, 0, NEUTRAL.stone, 0, 0.9, 0, 0, 0.6), 0.25, seed), 0.1, seed)};
}

/** 가로등: 기둥·받침·팔·갓 + 조명 무시 전구 */
export function sampleLamp(): Part {
  const solid = mergePlaced([
    {g: prism(6, 0.45, 0.6, NEUTRAL.steel)},
    {g: prism(6, 0.18, 6.2, NEUTRAL.slate)},
    {g: box(1.4, 0.16, 0.16, NEUTRAL.slate), x: 0.6, y: 6.1},
    {g: taper(1.1, 1.1, 0.5, 0.5, 0.4, NEUTRAL.steel), x: 1.3, y: 6.1},
  ]);
  return {solid, glow: ico(0.28, 0, PAL.amber, 1.3, 5.95, 0)};
}
