// 불러오기·저장·자동 저장(localStorage)·빌드 결과(city.compiled.json) 읽기. 도로 외 필드는 파싱한 그대로 보존한다.
import {sourceHash} from '../gen/bytes.js';
import type {CitySource} from '../city-schema.js';
import {runChecks} from './checks.js';
import {rebaseline} from './junctions-auto.js';
import {ed, emit, type CompiledGeo, type CompiledInfo} from './state.js';

/** 자동 저장 키. 형식이 바뀌면 버전(v1)을 올린다 */
export const AUTOSAVE_KEY = 'cityEditor/v1/autosave';
export const SOURCE_URL = 'data/city.source.json';
export const COMPILED_URL = 'data/city.compiled.json';

export function refreshIssues() {
  ed.issues = ed.doc ? runChecks(ed.doc) : [];
  emit('issues');
}
/** 열 수 없는 자료의 사유를 돌려준다(없으면 null) */
export function structureProblem(j: unknown): string | null {
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return '최상위가 객체가 아닙니다';
  const o = j as Record<string, unknown>;
  if (!Array.isArray(o.roads)) return '"roads" 배열이 없습니다';
  if (!Array.isArray(o.bounds)) return '"bounds" 배열이 없습니다';
  return null;
}
/** JSON 텍스트를 에디터에 올린다. 스키마 오류가 있어도 구조만 맞으면 열어서 고칠 수 있게 한다. 실패하면 사유 문자열 */
export function loadText(text: string, name: string, opts: {dirty?: boolean} = {}): string | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) { return `JSON 구문 오류: ${(e as Error).message}`; }
  const bad = structureProblem(j);
  if (bad) return `열 수 없는 파일 (${name}): ${bad}`;
  ed.doc = j as CitySource; ed.name = name; ed.undo = []; ed.redo = []; ed.draft = [];
  ed.selRoad = null; ed.selVert = -1; ed.dirty = !!opts.dirty; ed.ver++;
  rebaseline(ed.doc);
  refreshIssues();
  emit('doc'); emit('sel');
  return null;
}
export function fitView(w: number, h: number) {
  const b = ed.doc?.bounds as number[][] | undefined;
  if (!b || !b.length) return;
  const xs = b.map(p => p[0]), zs = b.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  ed.view.cx = (x0 + x1) / 2; ed.view.cz = (z0 + z1) / 2;
  ed.view.scale = Math.min(w / (x1 - x0 + 60), h / (z1 - z0 + 60));
  emit('view');
}
export async function loadDefault(): Promise<string | null> {
  try {
    const r = await fetch(SOURCE_URL, {cache: 'no-cache'});
    if (!r.ok) return `${SOURCE_URL} 를 가져오지 못했습니다 (HTTP ${r.status}). 파일을 직접 불러오세요.`;
    return loadText(await r.text(), 'city.source.json');
  } catch (e) { return `${SOURCE_URL} 를 가져오지 못했습니다: ${(e as Error).message}`; }
}
export async function loadFile(f: File): Promise<string | null> {
  const err = loadText(await f.text(), f.name);
  if (!err) saveAuto();
  return err;
}

// ───────── 내보내기 ─────────
export function exportText(): string { return JSON.stringify(ed.doc); }
export function exportName(): string { return ed.name.replace(/\.json$/i, '').replace(/\.edited$/, '') + '.edited.json'; }
export function download() {
  if (!ed.doc) return;
  const url = URL.createObjectURL(new Blob([exportText()], {type: 'application/json'}));
  const a = document.createElement('a');
  a.href = url; a.download = exportName(); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  ed.dirty = false; emit('ui');
}

// ───────── 자동 저장 ─────────
let timer = 0;
export function saveAuto() {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (!ed.doc) return;
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({v: 1, name: ed.name, savedAt: Date.now(), dirty: ed.dirty, json: exportText()})); } catch { /* 용량 초과·차단: 무시 */ }
  }, 250);
}
export function restoreAuto(): boolean {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    if (!s) return false;
    const o = JSON.parse(s);
    if (o?.v !== 1 || typeof o.json !== 'string') return false;
    return loadText(o.json, String(o.name || 'city.source.json'), {dirty: !!o.dirty}) === null;
  } catch { return false; }
}
export function clearAuto() { try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* 무시 */ } }

// ───────── 빌드 결과 ─────────
function compiledGeo(c: any): CompiledGeo | undefined {
  try {
    const roads = (c.roads ?? []).map((r: any) => ({id: r.id, cls: r.cls, xyz: (r.samples ?? []).flatMap((p: any) => [p.x, p.y, p.z])}));
    const buildings = (c.buildings ?? []).map((b: any) => ({id: b.id, x: b.x, z: b.z, w: b.w, d: b.d, rot: b.rot, floors: b.floors, style: b.style, groundY: b.groundY ?? 0}));
    return {roads, buildings};
  } catch { return undefined; }
}
export function parseCompiled(text: string, name: string): string | null {
  try {
    const c = JSON.parse(text);
    if (!c?.header || !Array.isArray(c.rejected)) return '빌드 결과(compiled)가 아닙니다 (header/rejected 없음)';
    const info: CompiledInfo = {name, revision: c.header.cityRevision, seed: c.header.seed, sourceHash: c.header.sourceHash, rejected: c.rejected, geo: compiledGeo(c)};
    ed.compiled = info; emit('ui');
    return null;
  } catch (e) { return `빌드 결과 JSON 구문 오류: ${(e as Error).message}`; }
}
export async function loadCompiledDefault(): Promise<void> {
  try { const r = await fetch(COMPILED_URL, {cache: 'no-cache'}); if (r.ok) parseCompiled(await r.text(), 'city.compiled.json'); } catch { /* 정적 파일이 없으면 조용히 건너뜀 */ }
}
/** 빌드 결과가 지금 편집본과 같은 원본에서 나왔는가 (null = 확인 불가) */
export function compiledFresh(): boolean | null {
  if (!ed.compiled || !ed.doc) return null;
  try { return sourceHash(ed.doc) === ed.compiled.sourceHash; } catch { return null; }
}

// ───────── 게임에서 보기 ─────────
/** boot.ts 의 LOCAL_DRAFT_KEY 와 같아야 한다(boot.ts 는 게임 전체를 끌어오므로 import 하지 않고 값만 맞춘다) */
export const GAME_DRAFT_KEY = 'steal-planet.city-draft.v1';
export const GAME_URL = 'index.html?debug=1&city=local';
/** 현재 편집본을 게임 로컬 초안으로 저장한다. 실패 사유(없으면 null) */
export function saveGameDraft(): string | null {
  if (!ed.doc) return '자료 없음';
  try { localStorage.setItem(GAME_DRAFT_KEY, exportText()); return null; } catch (e) { return `로컬 초안 저장 실패: ${(e as Error).message}`; }
}
