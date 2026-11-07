// 색 팔레트 토큰. 월드의 모든 색은 여기 이름 상수에서만 가져온다(임의 hex 금지)

/** 중립 12 */
export const NEUTRAL = {
  ink: 0x14161f, coal: 0x262a36, slate: 0x3b4152, steel: 0x5a6275,
  stone: 0x808899, ash: 0xa4abb8, fog: 0xc6ccd6, cloud: 0xe4e8ef,
  white: 0xffffff, bone: 0xd9d0bd, clay: 0x8a6a52, wood: 0x6b4a32,
} as const;

/** 도시 8 */
export const CITY = {
  brick: 0xa4503c, plaster: 0xe8dcc4, tileRed: 0xc2453a, tileBlue: 0x3f6fa8,
  glass: 0x7fb8d8, asphalt: 0x30343f, paving: 0x9a9fa8, awning: 0xe0a53a,
} as const;

/** 강조 12 */
export const ACCENT = {
  red: 0xe5483f, orange: 0xf08a3a, amber: 0xf5b73a, yellow: 0xf3e04a,
  lime: 0xa6d84a, green: 0x4cb860, teal: 0x2fb5a0, cyan: 0x45c8e8,
  blue: 0x4a82e8, violet: 0x8b62dc, magenta: 0xcc4ac0, pink: 0xf08cb4,
} as const;

export const PAL = {...NEUTRAL, ...CITY, ...ACCENT} as const;
export type PalName = keyof typeof PAL;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** 0xRRGGBB → [r,g,b] (0..1). r128 기본 출력은 선형이라 변환 없이 쓴다 */
export const rgb = (c: number): [number, number, number] => [(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

/** 두 색을 RGB 보간 */
export function mix(a: number, b: number, t: number): number {
  const k = clamp01(t),
    ch = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** 낮밤 틴트: 하늘/안개/반구광 하늘·땅/태양 색과 세기 */
export interface Tint {
  sky: number;
  fog: number;
  hemiSky: number;
  hemiGround: number;
  sun: number;
  hemiK: number;
  sunK: number;
}
export const TINT: Record<'day' | 'dusk' | 'night' | 'dawn', Tint> = {
  day: {sky: 0x8cc8f0, fog: 0xbcdcf0, hemiSky: 0xdcecff, hemiGround: 0x7a8a6a, sun: 0xfff2d8, hemiK: 0.95, sunK: 0.85},
  dusk: {sky: 0xe88a5a, fog: 0xd8a080, hemiSky: 0xffc8a0, hemiGround: 0x5a4a58, sun: 0xff9a5a, hemiK: 0.75, sunK: 0.7},
  night: {sky: 0x070a18, fog: 0x0c1128, hemiSky: 0x6078c0, hemiGround: 0x181c30, sun: 0x8aa0ff, hemiK: 0.55, sunK: 0.25},
  dawn: {sky: 0xf0b0a0, fog: 0xe0b8b0, hemiSky: 0xffd8d0, hemiGround: 0x586070, sun: 0xffc8a0, hemiK: 0.8, sunK: 0.6},
};

export function mixTint(a: Tint, b: Tint, t: number): Tint {
  const o = {...a} as Tint;
  (Object.keys(a) as (keyof Tint)[]).forEach(k => {
    o[k] = k === 'hemiK' || k === 'sunK' ? a[k] + (b[k] - a[k]) * clamp01(t) : mix(a[k], b[k], t);
  });
  return o;
}
