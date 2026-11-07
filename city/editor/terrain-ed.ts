// 에디터 지형: 기본 높이(ref/인라인) 해독 → terrain.edits(pad·brush) 순서 적용(증분 캐시) → 높이 이미지·도로 종단 경사 추정.
// 도로 회랑(corridor)·교차로 평탄화는 빌더 몫이라 여기서는 적용하지 않는다 → 경사는 "절토·성토 전 지형 기준 추정".
import {applyBrush, applyPad, makeTerrain, sampleBilinear, type Terrain} from '../gen/terrain.js';
import {decodeHeights} from '../city-terrain-codec.js';
import {ROAD_CLASS_DEFAULTS, type CitySource, type RoadSource, type TerrainEdit} from '../city-schema.js';
import {dense} from './roadops.js';
import {ed, emit} from './state.js';

let base: {key: string; t: Terrain} | null = null;      // 편집 적용 전 기본 지형
let work: {key: string; edits: string[]; t: Terrain} | null = null; // 지금까지 적용한 결과(편집 JSON 목록으로 증분 판단)
let loading: Promise<boolean> | null = null;
let baseUrl = '';

const gridKey = (d: CitySource) => JSON.stringify(d.terrain?.grid ?? null).slice(0, 400);
const clone = (t: Terrain): Terrain => ({...t, h: Float64Array.from(t.h), road: new Uint8Array(t.road.length)});

/** 기본 높이를 읽는다(처음 한 번). 실패하면 false 와 사유를 ed.terrainMsg 에 남긴다 */
export function loadBase(): Promise<boolean> {
  const d = ed.doc;
  if (!d?.terrain?.grid) return Promise.resolve(false);
  const key = gridKey(d);
  if (base?.key === key) return Promise.resolve(true);
  const g = d.terrain.grid;
  loading = (async () => {
    try {
      let cm: ArrayLike<number>;
      if (g.data) cm = decodeHeights(g.data, g.cols * g.rows);
      else if (g.ref) {
        const r = await fetch(g.ref, {cache: 'no-cache'});
        if (!r.ok) throw new Error(`${g.ref} HTTP ${r.status}`);
        const f = await r.json();
        if (f.nx !== g.cols || f.nz !== g.rows) throw new Error(`격자 크기 불일치 ${f.nx}x${f.nz} vs ${g.cols}x${g.rows}`);
        cm = decodeHeights(f.height, f.nx * f.nz);
      } else throw new Error('높이 data/ref 없음');
      base = {key, t: makeTerrain(g, cm)}; work = null; baseUrl = g.ref ?? 'inline'; ed.terrainMsg = '';
      return true;
    } catch (e) { base = null; ed.terrainMsg = `지형을 불러오지 못함: ${(e as Error).message}`; return false; }
  })();
  return loading;
}
const pre = (e: TerrainEdit) => e.kind === 'pad' || e.kind === 'brush';
const apply = (t: Terrain, e: TerrainEdit) => { if (e.kind === 'pad') applyPad(t, e); else if (e.kind === 'brush') applyBrush(t, e); };

/** 현재 문서의 편집을 적용한 지형. 편집 목록이 앞부분을 그대로 유지한 채 뒤에 늘었으면 새 것만 더 적용한다. 기본 높이가 아직 없으면 null */
export function currentTerrain(): Terrain | null {
  const d = ed.doc;
  if (!d || !base || base.key !== gridKey(d)) return null;
  const edits = d.terrain.edits.filter(pre), js = edits.map(e => JSON.stringify(e));
  if (work && work.key === base.key && work.edits.length <= js.length && work.edits.every((s, i) => s === js[i])) {
    for (let i = work.edits.length; i < js.length; i++) apply(work.t, edits[i]);
    work.edits = js; return work.t;
  }
  const t = clone(base.t);
  for (const e of edits) apply(t, e);
  work = {key: base.key, edits: js, t};
  return t;
}
export const terrainSource = () => baseUrl;

/** 점의 해발 */
export function heightAt(x: number, z: number): number | null {
  const t = currentTerrain();
  return t ? sampleBilinear(t, x, z) : null;
}

// ───────── 높이 이미지(2D 배경) ─────────
let img: {ver: string; cv: HTMLCanvasElement} | null = null;
export function heightImage(): {cv: HTMLCanvasElement; t: Terrain} | null {
  const t = currentTerrain();
  if (!t) return null;
  const ver = `${ed.ver}`;
  if (img && img.ver === ver) return {cv: img.cv, t};
  const cv = img?.cv ?? document.createElement('canvas');
  cv.width = t.cols; cv.height = t.rows;
  const c = cv.getContext('2d')!, im = c.createImageData(t.cols, t.rows);
  const lo = -5, hi = 45;
  for (let i = 0; i < t.h.length; i++) {
    const v = Math.max(0, Math.min(1, (t.h[i] - lo) / (hi - lo))), o = i * 4;
    // 낮음 파랑 → 초록 → 갈색 → 흰색, 간단한 구간 보간
    const r = v < 0.5 ? 40 + v * 160 : 120 + (v - 0.5) * 270, g = v < 0.5 ? 70 + v * 240 : 190 - (v - 0.5) * 120, b = v < 0.25 ? 140 - v * 300 : 60 + (v - 0.25) * 60;
    im.data[o] = r; im.data[o + 1] = g; im.data[o + 2] = b; im.data[o + 3] = 255;
  }
  c.putImageData(im, 0, 0);
  img = {ver, cv};
  return {cv, t};
}

// ───────── 도로 종단 경사 ─────────
export interface GradeHit { road: string; s0: number; s1: number; x: number; z: number; grade: number; limit: number }
const WIN_M = 10;
/** 구간 높이 프로파일(heights 키)이 있으면 그것, 없으면 지형 높이 */
function profileY(r: RoadSource, s: number, x: number, z: number, t: Terrain): number {
  for (const sg of r.segments ?? []) {
    const k = sg.heights;
    if (!k || k.length < 2 || s < k[0].s || s > k[k.length - 1].s) continue;
    for (let i = 1; i < k.length; i++) if (s <= k[i].s) { const u = (s - k[i - 1].s) / Math.max(1e-6, k[i].s - k[i - 1].s); return k[i - 1].y + (k[i].y - k[i - 1].y) * u; }
  }
  return sampleBilinear(t, x, z);
}
/** 도로 하나에서 10m 창 경사가 한도(등급 maxGrade)를 넘는 연속 구간들 */
export function roadGradeHits(r: RoadSource, t: Terrain): GradeHit[] {
  const prof = ROAD_CLASS_DEFAULTS[r.cls], out: GradeHit[] = [];
  if (!prof) return out; // 등급이 잘못된 도로는 스키마 검증이 따로 보고
  const dn = dense(r), limit = prof.maxGrade;
  if (dn.n < 3) return out;
  const y = new Float64Array(dn.n);
  for (let i = 0; i < dn.n; i++) y[i] = profileY(r, dn.s[i], dn.x[i], dn.z[i], t);
  let open: GradeHit | null = null;
  for (let i = 0; i < dn.n; i++) {
    let j = i;
    while (j < dn.n - 1 && dn.s[j] - dn.s[i] < WIN_M) j++;
    const ds = dn.s[j] - dn.s[i], g = ds > 4 ? Math.abs(y[j] - y[i]) / ds : 0;
    if (g > limit) {
      if (!open) open = {road: r.id, s0: dn.s[i], s1: dn.s[j], x: dn.x[i], z: dn.z[i], grade: g, limit};
      else { open.s1 = dn.s[j]; open.grade = Math.max(open.grade, g); }
    } else if (open) { out.push(open); open = null; }
  }
  if (open) out.push(open);
  return out;
}
let gradeCache: {ver: number; hits: GradeHit[]} | null = null;
export function allGradeHits(): GradeHit[] {
  if (gradeCache && gradeCache.ver === ed.ver) return gradeCache.hits;
  const t = currentTerrain(), hits: GradeHit[] = [];
  if (t && ed.doc) for (const r of ed.doc.roads) if (r.pts.length >= 2) hits.push(...roadGradeHits(r, t));
  gradeCache = {ver: ed.ver, hits};
  return hits;
}
/** 시작 시 한 번 기본 높이를 읽고 화면·검사를 다시 그리게 한다 */
export async function ensureTerrain(): Promise<boolean> {
  const ok = await loadBase();
  if (ok) { currentTerrain(); gradeCache = null; img = null; }
  emit('ui'); emit('view');
  return ok;
}
export function brushRaster(): Terrain | null { return currentTerrain(); }
