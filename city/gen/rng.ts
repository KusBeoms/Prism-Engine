// 시드 난수(순수). 구역·필지·도로별 하위 시드를 (seed, 키들)에서 만들어, 한 구역을 다시 만들어도 다른 구역의 난수열이 섞이지 않게 한다.
/** 문자열 32비트 FNV-1a */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
/** (seed, 키...) → 32비트 하위 시드. 키 순서가 다르면 다른 값 */
export function subSeed(seed: number, ...keys: (string | number)[]): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (const k of keys) {
    h = Math.imul(h ^ hash32(String(k)), 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  }
  return h >>> 0;
}
export class Rng {
  private a: number;
  constructor(seed: number) { this.a = seed >>> 0; }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hi: number): number { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(a: readonly T[]): T { return a[Math.min(a.length - 1, Math.floor(this.next() * a.length))]; }
  /** 가중 선택: weights 합으로 정규화 */
  weighted<T>(a: readonly T[], w: readonly number[]): T {
    let sum = 0; for (const v of w) sum += v;
    let r = this.next() * sum;
    for (let i = 0; i < a.length; i++) { r -= w[i]; if (r < 0) return a[i]; }
    return a[a.length - 1];
  }
}
export const rngFor = (seed: number, ...keys: (string | number)[]): Rng => new Rng(subSeed(seed, ...keys));
