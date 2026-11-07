// 바이트·해시 유틸 (순수). 정규 JSON·FNV 해시·base64·RLE 를 모아 둔다. DOM/Node 전용 API 를 쓰지 않는다(btoa/atob 는 Node 16+ 와 브라우저 공통).

/** 키를 정렬한 정규 JSON 문자열. 같은 내용이면 항상 같은 문자열 (undefined 값은 건너뛴다) */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

/** FNV-1a 32bit 두 번(서로 다른 시작값) → 16자리 hex. 문자열은 UTF-16 코드 단위 기준 */
export function fnvHex(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** 원본 해시: 정규 JSON 의 FNV. 키 순서·공백에 무관 */
export function sourceHash(source: unknown): string {
  return fnvHex(canonicalJson(source));
}

export function bytesToB64(b: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.prototype.slice.call(b, i, i + 0x8000) as number[]);
  return btoa(s);
}
export function b64ToBytes(s: string): Uint8Array {
  const t = atob(s), b = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
  return b;
}

function pushVar(out: number[], v: number): void {
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}
/** 바이트 배열의 (값, 반복 길이) 런 인코딩 → base64. 마스크처럼 같은 값이 길게 이어지는 데이터용 */
export function encodeBytesRle(a: ArrayLike<number>): string {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i] & 255;
    let j = i + 1;
    while (j < a.length && (a[j] & 255) === v) j++;
    out.push(v);
    pushVar(out, j - i);
    i = j;
  }
  return bytesToB64(out);
}
export function decodeBytesRle(b64: string, n: number): Uint8Array {
  const b = b64ToBytes(b64), out = new Uint8Array(n);
  let p = 0, i = 0;
  while (p < b.length) {
    const v = b[p++];
    let run = 0, m = 1;
    for (;;) { const c = b[p++]; run += (c & 0x7f) * m; if (c < 0x80) break; m *= 128; }
    if (i + run > n) throw new Error('citygen: RLE 길이가 예상보다 길다');
    out.fill(v, i, i + run);
    i += run;
  }
  if (i !== n) throw new Error('citygen: RLE 길이가 예상과 다르다');
  return out;
}

/** 숫자를 소수 d 자리로 반올림(-0 → 0). JSON 크기 절감과 결정성을 위해 출력 직전에 쓴다 */
export function rnd(v: number, d = 2): number {
  const m = Math.pow(10, d), r = Math.round(v * m) / m;
  return r === 0 ? 0 : r;
}
