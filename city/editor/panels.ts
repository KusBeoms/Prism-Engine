// 우측 패널 DOM: 도로 속성, 도로 목록, 검증 결과, 빌드 거부. 사용자 JSON 문자열은 textContent 로만 넣는다.
import {CLS_COLOR, CLS_LABEL} from './draw.js';
import {compiledFresh} from './io.js';
import {roadLength} from './roadops.js';
import {deleteSelection, setClass, toggleCurve} from './input.js';
import {isBusy, server} from './server-io.js';
import {ed, emit, roadById, select, selected, type Issue} from './state.js';
import {ROAD_CLASSES} from '../city-schema.js';
import {renderObjProps, renderZonePalette} from './panels2.js';

export type Kids = Array<Node | string | null | undefined>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kids): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 월드 좌표로 시점을 옮긴다(확대가 너무 작으면 키운다) */
export function focusAt(x: number, z: number, minScale = 1.2) {
  ed.view.cx = x; ed.view.cz = z; ed.view.scale = Math.max(ed.view.scale, minScale); emit('view');
}
export function focusRoad(id: string) {
  const r = roadById(id);
  if (!r) return false;
  select(id);
  const xs = r.pts.map(p => p[0]), zs = r.pts.map(p => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...zs) - Math.min(...zs);
  focusAt((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...zs) + Math.min(...zs)) / 2, Math.min(4, Math.max(ed.view.scale, 400 / Math.max(60, w, hh))));
  return true;
}
const chip = (cls: string) => { const c = h('span', {class: 'chip'}, CLS_LABEL[cls] ?? cls); c.style.background = CLS_COLOR[cls] ?? '#888'; return c; };

export function renderProps() {
  const box = $('props'), r = selected();
  box.replaceChildren();
  if (ed.tool === 'zone') renderZonePalette(box);
  if (ed.selObj) { renderObjProps(box); return; }
  if (!r) { if (ed.tool !== 'zone') box.append(h('div', {class: 'muted'}, ed.doc ? '클릭해 선택 (? = 단축키 도움말)' : '자료 없음')); return; }
  const sel = h('select', {id: 'propCls'});
  for (const c of ROAD_CLASSES) { const o = h('option', {value: c}, `${c} (${CLS_LABEL[c]})`); if (c === r.cls) o.selected = true; sel.append(o); }
  sel.onchange = () => setClass(sel.value);
  const curve = h('button', {id: 'btnCurve'}, r.curve === 'catmull' ? '직선으로 전환' : '곡선으로 전환');
  curve.onclick = toggleCurve;
  const del = h('button', {id: 'btnDelRoad', class: 'danger'}, '도로 삭제');
  del.onclick = () => { ed.selVert = -1; deleteSelection(); };
  const delV = h('button', {id: 'btnDelVert'}, '점 삭제');
  delV.disabled = ed.selVert < 0 || r.pts.length <= 2;
  delV.onclick = deleteSelection;
  const v = ed.selVert >= 0 ? r.pts[ed.selVert] : null;
  box.append(
    h('div', {class: 'row'}, h('b', {id: 'propId'}, r.id), r.name ? h('span', {class: 'muted'}, ` ${r.name}`) : null),
    h('div', {class: 'row'}, '등급 ', sel),
    h('div', {class: 'row muted'}, `곡선 ${r.curve} · 점 ${r.pts.length}개 · 길이 ${roadLength(r).toFixed(1)}m`, r.segments ? ` · 구간 ${r.segments.length}` : ''),
    h('div', {class: 'row muted'}, v ? `선택한 점 #${ed.selVert}: (${v[0]}, ${v[1]})` : '점을 드래그해 이동, 도로 위 더블클릭으로 점 삽입'),
    h('div', {class: 'row btns'}, curve, delV, del),
  );
}

function rowOf(id: string, ...kids: Kids): HTMLElement {
  const row = h('div', {class: 'item' + (ed.selRoad === id ? ' on' : ''), 'data-road': id}, ...kids);
  return row;
}
export function renderRoads() {
  const list = $('list-roads'), q = $<HTMLInputElement>('filter').value.trim().toLowerCase();
  list.replaceChildren();
  const rej = new Set((ed.compiled?.rejected ?? []).map(x => x.owner));
  for (const r of ed.doc?.roads ?? []) {
    if (q && !r.id.toLowerCase().includes(q) && !r.cls.includes(q)) continue;
    const row = rowOf(r.id, h('span', {class: 'rid'}, r.id), chip(r.cls), h('span', {class: 'len'}, `${roadLength(r).toFixed(0)}m`), rej.has(r.id) ? h('span', {class: 'bad'}, '거부') : null);
    row.onclick = () => focusRoad(r.id);
    list.append(row);
  }
  $('cnt-roads').textContent = String(ed.doc?.roads.length ?? 0);
}
const issueRow = (s: Issue) => {
  const row = h('div', {class: `item ${s.sev}`}, h('span', {class: 'sev'}, s.sev === 'error' ? '오류' : '경고'), h('span', {class: 'msg'}, s.msg));
  row.onclick = () => {
    if (s.road && focusRoad(s.road)) { if (s.at) focusAt(s.at[0], s.at[1], ed.view.scale); }
    else if (s.at) focusAt(s.at[0], s.at[1]);
  };
  return row;
};
export function renderIssues() {
  const list = $('list-issues');
  list.replaceChildren();
  const err = ed.issues.filter(s => s.sev === 'error').length;
  if (!ed.issues.length) list.append(h('div', {class: 'ok', id: 'issuesOk'}, '문제 없음'));
  for (const s of ed.issues) list.append(issueRow(s));
  $('cnt-issues').textContent = `${err}/${ed.issues.length - err}`;
  $('cnt-issues').className = err ? 'bad' : '';
}
export function renderRejected() {
  const list = $('list-rej'), c = ed.compiled;
  list.replaceChildren();
  if (!c) {
    list.append(h('div', {class: 'muted'}, '빌드 결과 없음. 터미널에서 `npm run build:city` 후 "빌드 결과 열기"로 data/city.compiled.json 을 고르세요.'));
    $('cnt-rej').textContent = '-'; return;
  }
  const fresh = compiledFresh();
  list.append(h('div', {class: fresh === false ? 'warnbox' : 'muted'}, `${c.name} · 개정 ${c.revision} · 거부 ${c.rejected.length}건 · ` + (fresh === null ? '최신 여부 확인 불가' : fresh ? '현재 편집본과 일치' : '편집본과 다름 — 다시 빌드해야 최신 사유가 보임')));
  const ids = new Set(ed.doc?.roads.map(r => r.id));
  const key = (o: string) => (ids.has(o) ? o : ids.has(o.split('@').pop() ?? '') ? o.split('@').pop()! : null);
  const sorted = [...c.rejected].sort((a, b) => Number(!!key(b.owner)) - Number(!!key(a.owner)));
  for (const x of sorted.slice(0, 400)) {
    const rid = key(x.owner);
    const row = h('div', {class: 'item' + (rid ? ' link' : '')}, h('span', {class: 'sev'}, x.code), h('span', {class: 'msg'}, `${x.owner}: ${x.msg}`));
    if (rid) row.onclick = () => focusRoad(rid);
    list.append(row);
  }
  if (sorted.length > 400) list.append(h('div', {class: 'muted'}, `... 외 ${sorted.length - 400}건 생략`));
  $('cnt-rej').textContent = String(c.rejected.length);
}
export function renderStatus(hover: [number, number] | null) {
  const d = ed.doc;
  $('status').textContent = `${ed.name || '-'}${ed.dirty ? ' ●수정됨' : ''} · 도로 ${d?.roads.length ?? 0} · 확대 ${ed.view.scale.toFixed(2)}px/m` + (hover ? ` · (${hover[0].toFixed(1)}, ${hover[1].toFixed(1)})` : '') + (ed.draft.length ? ` · 그리는 중 ${ed.draft.length}점 (더블클릭/Enter 완료, Esc 취소)` : '') + (ed.msg ? ` · ${ed.msg}` : '') + (ed.jxMsg ? ` · ${ed.jxMsg}` : '');
  $<HTMLButtonElement>('btnUndo').disabled = !ed.undo.length;
  $<HTMLButtonElement>('btnRedo').disabled = !ed.redo.length;
  $('toolSel').classList.toggle('on', ed.tool === 'select');
  $('toolDraw').classList.toggle('on', ed.tool === 'draw');
  const sb = $<HTMLButtonElement>('btnSave'); sb.textContent = server.up ? '저장' : '저장(다운로드)'; sb.disabled = isBusy();
  $<HTMLButtonElement>('btnBuild').classList.toggle('hidden', !server.up); $<HTMLButtonElement>('btnBuild').disabled = isBusy();
  for (const t of ['zone', 'anchor', 'building', 'brush']) $('tool-' + t).classList.toggle('on', ed.tool === t);
}
export function showBanner(msg: string, kind: 'info' | 'error' = 'info') {
  const b = $('banner'); b.textContent = msg; b.className = msg ? kind : 'hidden';
}
