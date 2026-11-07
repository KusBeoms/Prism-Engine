// 도시 섬 높이 JSON(city-terrain/1) 코덱. 순수 함수 — 게임 모듈을 import 하지 않는다 (오프라인 도구·로더·테스트 공용).
// 높이 = 정수 cm. 격자 행 우선(j*nx+i), 델타 = 직전 칸과의 차(첫 칸은 0 기준), 지그재그+varint(LEB128) 바이트열을 base64 로 쓴다.
// 땅 마스크 = 0/1 런 길이(0 부터 시작) varint 바이트열의 base64.

export const TERRAIN_SCHEMA = 'city-terrain/1';

export interface CityTerrainFile {
  schema: typeof TERRAIN_SCHEMA;
  /** 격자 원점(월드 x,z) · 간격(u) · 칸 수 */
  origin: {x: number; z: number};
  step: number;
  nx: number;
  nz: number;
  unit: 'cm';
  /** 월드 bbox (원점 ~ 원점+(n-1)*step) */
  bbox: {x0: number; x1: number; z0: number; z1: number};
  encoding: {height: 'delta-zigzag-varint-b64'; land: 'rle-varint-b64'};
  /** 높이(cm) 델타 인코딩 */
  height: string;
  /** 땅 마스크 런 인코딩 */
  land: string;
  /** 굽기 매개변수 · 통계 (자유 형식) */
  params: Record<string, unknown>;
  stats: {min: number; max: number; checksum: string; [k: string]: unknown};
}
export interface CityTerrain {
  origin: {x: number; z: number};
  step: number;
  nx: number;
  nz: number;
  /** 높이 cm, 행 우선 */
  cm: Int32Array;
  /** 1 = 도시 땅(윤곽 안), 0 = 바다·낭떠러지 */
  land: Uint8Array;
}

function pushVar(out: number[], v: number): void {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}
function readVar(b: Uint8Array, pos: {p: number}): number {
  let v = 0,
    m = 1;
  for (;;) {
    if (pos.p >= b.length) throw new Error('city-terrain: varint 데이터가 끝났다');
    const c = b[pos.p++];
    v += (c & 0x7f) * m;
    if (c < 0x80) return v;
    m *= 128;
  }
}
function toB64(b: number[]): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.slice(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const t = atob(s),
    b = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
  return b;
}

export function encodeHeights(cm: ArrayLike<number>): string {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < cm.length; i++) {
    const v = Math.round(cm[i]),
      d = v - prev;
    pushVar(out, d >= 0 ? d * 2 : -d * 2 - 1);
    prev = v;
  }
  return toB64(out);
}
export function decodeHeights(b64: string, n: number): Int32Array {
  const b = fromB64(b64),
    pos = {p: 0},
    cm = new Int32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const z = readVar(b, pos);
    prev += z % 2 ? -(z + 1) / 2 : z / 2;
    cm[i] = prev;
  }
  if (pos.p !== b.length) throw new Error('city-terrain: 높이 데이터 길이가 격자와 맞지 않는다');
  return cm;
}
export function encodeLand(land: ArrayLike<number>): string {
  const out: number[] = [];
  let cur = 0,
    run = 0;
  for (let i = 0; i < land.length; i++) {
    const v = land[i] ? 1 : 0;
    if (v === cur) run++;
    else {
      pushVar(out, run);
      cur = v;
      run = 1;
    }
  }
  pushVar(out, run);
  return toB64(out);
}
export function decodeLand(b64: string, n: number): Uint8Array {
  const b = fromB64(b64),
    pos = {p: 0},
    land = new Uint8Array(n);
  let i = 0,
    cur = 0;
  while (pos.p < b.length) {
    const run = readVar(b, pos);
    if (i + run > n) throw new Error('city-terrain: 마스크 길이가 격자보다 길다');
    if (cur) land.fill(1, i, i + run);
    i += run;
    cur ^= 1;
  }
  if (i !== n) throw new Error('city-terrain: 마스크 길이가 격자와 맞지 않는다');
  return land;
}
/** FNV-1a 32bit (cm 값 전체, 8자리 hex) */
export function checksumCm(cm: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < cm.length; i++) {
    const v = cm[i] | 0;
    for (let s = 0; s < 32; s += 8) {
      h ^= (v >>> s) & 255;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 파일 객체 → 격자. 스키마·크기·체크섬을 검증하고 어긋나면 던진다 (폴백 없음) */
export function decodeTerrain(f: CityTerrainFile): CityTerrain {
  if (f.schema !== TERRAIN_SCHEMA) throw new Error(`city-terrain: 알 수 없는 스키마 ${String(f.schema)}`);
  const n = f.nx * f.nz,
    cm = decodeHeights(f.height, n),
    land = decodeLand(f.land, n);
  if (checksumCm(cm) !== f.stats.checksum) throw new Error('city-terrain: 체크섬 불일치 (파일 손상)');
  return {origin: f.origin, step: f.step, nx: f.nx, nz: f.nz, cm, land};
}
/** 격자 → 파일 객체 (params/stats.extra 는 호출자가 채운다) */
export function encodeTerrain(t: CityTerrain, params: Record<string, unknown>, extra: Record<string, unknown> = {}): CityTerrainFile {
  const n = t.nx * t.nz;
  if (t.cm.length !== n || t.land.length !== n) throw new Error('city-terrain: 배열 크기가 nx*nz 와 다르다');
  let mn = Infinity,
    mx = -Infinity;
  for (let i = 0; i < n; i++) {
    mn = Math.min(mn, t.cm[i]);
    mx = Math.max(mx, t.cm[i]);
  }
  return {
    schema: TERRAIN_SCHEMA,
    origin: t.origin,
    step: t.step,
    nx: t.nx,
    nz: t.nz,
    unit: 'cm',
    bbox: {x0: t.origin.x, x1: t.origin.x + (t.nx - 1) * t.step, z0: t.origin.z, z1: t.origin.z + (t.nz - 1) * t.step},
    encoding: {height: 'delta-zigzag-varint-b64', land: 'rle-varint-b64'},
    height: encodeHeights(t.cm),
    land: encodeLand(t.land),
    params,
    stats: {min: mn, max: mx, checksum: checksumCm(t.cm), ...extra},
  };
}
