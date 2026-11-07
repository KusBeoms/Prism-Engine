// 우측 패널(객체): 구역·앵커·노드·건물·지형 편집 속성, 도구 옵션 줄, 객체 목록. 사용자 문자열은 textContent 로만 넣는다.
import {ANCHOR_KINDS, BUILDING_STYLES, NODE_KINDS, ZONE_USES, type AnchorKind, type BuildingStyle, type NodeKind, type ZoneUse} from '../city-schema.js';
import {$, focusAt, h} from './panels.js';
import {ZONE_FILL} from './draw.js';
import {deleteObj, deleteZoneVertex, editSummary, fitDoor, isStyle, polyArea, setNodeKind} from './objops.js';
import {setZoneName, ZONE_NAME_MAX} from './names.js';
import {ed, emit, mutateDoc, objList, objOf, selectObj, type ObjKind} from './state.js';

type Num = {id: string; label: string; get: () => number; set: (v: number) => void; min?: number; max?: number; step?: number};
function numField(f: Num): HTMLElement {
  const i = h('input', {type: 'number', id: `f-${f.id}`, step: String(f.step ?? 1)});
  if (f.min !== undefined) i.min = String(f.min);
  if (f.max !== undefined) i.max = String(f.max);
  i.value = String(Math.round(f.get() * 100) / 100);
  i.onchange = () => {
    let v = parseFloat(i.value);
    if (!Number.isFinite(v)) { i.value = String(f.get()); return; }
    if (f.min !== undefined) v = Math.max(f.min, v);
    if (f.max !== undefined) v = Math.min(f.max, v);
    mutateDoc(() => f.set(v));
  };
  return h('label', {class: 'fld'}, f.label, i);
}
function selField<T extends string>(id: string, label: string, opts: readonly T[], cur: T, set: (v: T) => void): HTMLElement {
  const s = h('select', {id: `f-${id}`});
  for (const o of opts) { const e = h('option', {value: o}, o); if (o === cur) e.selected = true; s.append(e); }
  s.onchange = () => set(s.value as T);
  return h('label', {class: 'fld'}, label, s);
}
const delBtn = (label: string, fn: () => void, id = 'btnDelObj') => { const b = h('button', {id, class: 'danger'}, label); b.onclick = fn; return b; };

export function renderObjProps(box: HTMLElement) {
  const s = ed.selObj, o = objOf<any>(s);
  if (!s || !o) { box.append(h('div', {class: 'muted'}, '선택 대상 없음')); return; }
  const head = h('div', {class: 'row'}, h('b', {id: 'propId'}, o.id), h('span', {class: 'muted'}, ` ${({zone: '구역', anchor: '앵커', node: '노드', building: '건물', edit: '지형 편집'})[s.kind]}`));
  box.append(head);
  if (s.kind === 'zone') {
    const nm = h('input', {type: 'text', id: 'f-zname', maxlength: String(ZONE_NAME_MAX), placeholder: '구역 이름(선택)'});
    nm.value = o.name ?? '';
    nm.onchange = () => setZoneName(o, nm.value);
    nm.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') nm.blur(); };
    box.append(
      h('label', {class: 'fld'}, '이름', nm),
      selField('use', '용도', ZONE_USES, o.use, v => mutateDoc(() => { o.use = v as ZoneUse; })),
      numField({id: 'density', label: '밀도 0~1', get: () => o.density ?? 0.5, set: v => { o.density = v; }, min: 0, max: 1, step: 0.05}),
      h('div', {class: 'row muted'}, `점 ${o.poly.length}개 · 면적 ${polyArea(o.poly).toFixed(0)}㎡` + (s.vert >= 0 ? ` · 점 #${s.vert} 선택` : ' · 점 드래그, 변 더블클릭=점 삽입')),
      h('div', {class: 'row btns'}, (() => { const b = h('button', {id: 'btnDelVertZ'}, '점 삭제'); b.disabled = s.vert < 0 || o.poly.length <= 3; b.onclick = () => { deleteZoneVertex(o, s.vert); selectObj('zone', o.id); }; return b; })(), delBtn('구역 삭제', () => deleteObj(s))),
    );
  } else if (s.kind === 'anchor') {
    box.append(
      selField('kind', '종류', ANCHOR_KINDS, o.kind, v => mutateDoc(() => { o.kind = v as AnchorKind; })),
      h('div', {class: 'row2'}, numField({id: 'x', label: 'x', get: () => o.x, set: v => { o.x = v; }, step: 0.5}), numField({id: 'z', label: 'z', get: () => o.z, set: v => { o.z = v; }, step: 0.5})),
      h('div', {class: 'row2'}, numField({id: 'rot', label: '회전°', get: () => o.rot ?? 0, set: v => { o.rot = ((v % 360) + 360) % 360; }, min: -360, max: 720, step: 5}), numField({id: 'flat', label: '평탄화 반경', get: () => o.flattenRadius, set: v => { o.flattenRadius = v; }, min: 0, max: 200})),
      (() => { const c = h('input', {type: 'checkbox', id: 'f-fixed'}); c.checked = !!o.fixed; c.onchange = () => mutateDoc(() => { o.fixed = c.checked; }); return h('label', {class: 'row'}, c, ' 고정 앵커 (이동·삭제 방지)'); })(),
      h('div', {class: 'row muted'}, '드래그=이동, 주황 점 드래그 또는 [ ] 키=회전'),
      h('div', {class: 'row btns'}, delBtn('앵커 삭제', () => deleteObj(s))),
    );
  } else if (s.kind === 'node') {
    box.append(
      selField('kind', '종류', NODE_KINDS, o.kind, v => setNodeKind(o.id, v as NodeKind)),
      h('div', {class: 'row muted'}, `(${o.at[0]}, ${o.at[1]}) · 층 ${o.layer} · 도로 ${o.roads.join(', ')}`),
    );
  } else if (s.kind === 'building') {
    const fix = () => fitDoor(o);
    box.append(
      selField('style', '양식', BUILDING_STYLES, o.style, v => mutateDoc(() => { o.style = v as BuildingStyle; })),
      h('div', {class: 'row2'}, numField({id: 'x', label: 'x', get: () => o.x, set: v => { o.x = v; }, step: 0.5}), numField({id: 'z', label: 'z', get: () => o.z, set: v => { o.z = v; }, step: 0.5})),
      h('div', {class: 'row2'}, numField({id: 'w', label: '폭 w', get: () => o.w, set: v => { o.w = v; fix(); }, min: 3, max: 150, step: 0.5}), numField({id: 'd', label: '깊이 d', get: () => o.d, set: v => { o.d = v; fix(); }, min: 3, max: 150, step: 0.5})),
      h('div', {class: 'row2'}, numField({id: 'rot', label: '회전°', get: () => o.rot, set: v => { o.rot = v; }, min: -360, max: 360, step: 5}), numField({id: 'floors', label: '층', get: () => o.floors, set: v => { o.floors = Math.round(v); o.interior.floors = Math.round(v); }, min: 1, max: 60})),
      selField('facing', '문 방향', ['s', 'n', 'e', 'w'] as const, o.interior.door.facing, v => mutateDoc(() => { o.interior.door.facing = v; fix(); })),
      h('div', {class: 'row btns'}, delBtn('건물 삭제', () => deleteObj(s))),
    );
  } else {
    box.append(h('div', {class: 'row muted'}, editSummary(o)), h('div', {class: 'row btns'}, delBtn('편집 삭제', () => deleteObj(s))));
  }
}

// ───────── 구역 브러시 팔레트(우측 패널) ─────────
export function renderZonePalette(box: HTMLElement) {
  const wrap = h('div', {class: 'zpal', id: 'zonePalette'});
  wrap.append(h('div', {class: 'row'}, h('b', {}, '구역 브러시'), h('span', {class: 'muted'}, ' 칠할 용도 (빈 곳에서 시작할 때)')));
  const grid = h('div', {class: 'zgrid'});
  for (const u of ZONE_USES) {
    const b = h('button', {id: `zu-${u}`, class: 'zbtn' + (ed.zoneUse === u ? ' on' : ''), title: u}, u);
    b.style.borderLeft = `10px solid ${ZONE_FILL[u]}`;
    b.onclick = () => { ed.zoneUse = u; emit('view'); renderZonePaletteAgain(); };
    grid.append(b);
  }
  const r = h('input', {type: 'range', id: 'zbrSlider', min: '2', max: '80', step: '1'});
  r.value = String(ed.zbr);
  const val = h('span', {id: 'zbrVal'}, `${ed.zbr}m`);
  r.oninput = () => { ed.zbr = +r.value; val.textContent = `${ed.zbr}m`; emit('view'); };
  wrap.append(grid, h('div', {class: 'row'}, '반경 ', r, ' ', val, h('span', {class: 'muted'}, '  [ ]')),
    h('div', {class: 'row muted'}, '기존 구역 안에서 시작=확장 · 빈 곳=새 구역 · ⌥ 지우개 · ⇧ 새 구역 강제 (? 도움말)'));
  box.append(wrap);
}
function renderZonePaletteAgain() { for (const b of document.querySelectorAll('#zonePalette .zbtn')) b.classList.toggle('on', b.id === `zu-${ed.zoneUse}`); }

// ───────── 도구 옵션 줄 ─────────
export function renderToolOpts() {
  const box = $('toolopts');
  box.replaceChildren();
  const t = ed.tool;
  box.classList.toggle('hidden', !(t === 'zone' || t === 'anchor' || t === 'building' || t === 'brush'));
  const num = (id: string, label: string, v: number, set: (n: number) => void, min: number, max: number, step = 1) => {
    const i = h('input', {type: 'number', id, min: String(min), max: String(max), step: String(step)});
    i.value = String(v); i.onchange = () => { const n = parseFloat(i.value); if (Number.isFinite(n)) set(Math.max(min, Math.min(max, n))); i.value = String(v); };
    return h('label', {}, label, i);
  };
  if (t === 'zone') box.append(h('span', {class: 'muted'}, '구역 브러시: 드래그로 칠하기 · ⌥ 지우개 · ⇧ 새 구역 · [ ] 반경 — 용도와 반경은 오른쪽 패널'));
  if (t === 'anchor') box.append(h('span', {}, '앵커 종류 '), selField('anchorKind', '', ANCHOR_KINDS, ed.anchorKind, v => { ed.anchorKind = v; }), h('span', {class: 'muted'}, '클릭하면 배치 (고정 아님, 평탄화 반경 12m)'));
  if (t === 'building') {
    const b = ed.bld;
    box.append(num('bw', '폭', b.w, n => { b.w = n; emit('view'); }, 3, 150, 0.5), num('bd', '깊이', b.d, n => { b.d = n; emit('view'); }, 3, 150, 0.5), num('brot', '회전°', b.rot, n => { b.rot = n; emit('view'); }, -360, 360, 5), num('bfl', '층', b.floors, n => { b.floors = Math.round(n); }, 1, 60),
      selField('bstyle', '양식', BUILDING_STYLES, b.style, v => { if (isStyle(v)) b.style = v; }), h('span', {class: 'muted'}, '클릭하면 배치'));
  }
  if (t === 'brush') {
    const b = ed.brush;
    box.append(selField('bmode', '모드', ['raise', 'lower', 'flatten', 'smooth'] as const, b.mode, v => { b.mode = v; }), num('br', '반경', b.r, n => { b.r = n; emit('view'); }, 1, 200), num('bs', '세기', b.strength, n => { b.strength = n; }, 0, 1, 0.1), h('span', {class: 'muted'}, '드래그로 칠하기 · 높이 표시를 켜면 결과가 보임'));
  }
}

// ───────── 객체 목록 ─────────
export function renderObjList() {
  const list = $('list-objs'), kind = ($<HTMLSelectElement>('objKind').value || 'zone') as ObjKind, q = $<HTMLInputElement>('filter').value.trim().toLowerCase();
  list.replaceChildren();
  for (const o of objList(kind) as any[]) {
    if (q && !String(o.id).toLowerCase().includes(q) && !String(o.name ?? '').toLowerCase().includes(q)) continue;
    const sum = kind === 'zone' ? (o.name ? `${o.name} · ${o.use}` : o.use) : kind === 'anchor' ? `${o.kind}${o.fixed ? ' 고정' : ''}` : kind === 'node' ? o.kind : kind === 'building' ? `${o.w}×${o.d} ${o.floors}층 ${o.style}` : editSummary(o);
    const row = h('div', {class: 'item' + (ed.selObj?.kind === kind && ed.selObj.id === o.id ? ' on' : ''), 'data-obj': o.id}, h('span', {class: 'rid'}, o.id), h('span', {class: 'len'}, sum));
    row.onclick = () => {
      selectObj(kind, o.id);
      const p = kind === 'zone' ? o.poly[0] : kind === 'node' ? o.at : kind === 'edit' ? (o.pts?.[0] ?? (o.x !== undefined ? [o.x, o.z] : null)) : [o.x, o.z];
      if (p) focusAt(p[0], p[1]);
    };
    list.append(row);
  }
  $('cnt-objs').textContent = String(objList(kind).length);
}
