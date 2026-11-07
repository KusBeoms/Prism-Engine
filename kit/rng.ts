// 시드 난수와 값 노이즈. 전부 순수 함수라 같은 입력이면 같은 결과가 나온다

/** 32비트 시드 PRNG. 호출할 때마다 [0,1) 을 돌려준다 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (r: () => number, a: number, b: number) => a + (b - a) * r();
export const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];

/** 정수 격자점 (x,z) 의 해시 난수 [0,1) */
export function hash2(x: number, z: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** 값 노이즈 [0,1): 격자점 해시를 smoothstep 으로 쌍선형 보간 */
export function noise2(x: number, z: number, seed = 0): number {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    fx = smooth(x - ix),
    fz = smooth(z - iz);
  const a = hash2(ix, iz, seed),
    b = hash2(ix + 1, iz, seed),
    c = hash2(ix, iz + 1, seed),
    d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** 옥타브 합성 노이즈 [0,1): 옥타브마다 주파수 ×2, 진폭 ×0.5 */
export function fbm(x: number, z: number, octaves = 4, seed = 0): number {
  let sum = 0,
    amp = 0.5,
    norm = 0,
    f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * f, z * f, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}
