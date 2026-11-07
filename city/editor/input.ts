// 캔버스 입력: 선택·정점 이동/삽입/삭제·새 도로 그리기·이동(팬)·확대·단축키.
import {setHover, toWorld} from './draw.js';
import {hitRoad, hitVertex, insertPoint, lengthNow, nearest, removePoint, round1, segIndexAt, uniqueRoadId} from './roadops.js';
import {ed, emit, mutate, mutateDoc, pushUndo, roadById, runAfterEdit, select, selected, setMsg, touched} from './state.js';
import {coincident, deleteRoadRefs, detachPointRefs, moveNodesAt, rescaleRoad, summarize, zeroCounts} from './refs.js';
import {deleteObjSelection, dragging, objDbl, objMove, objUp, rotateSel, selDown, toolDown} from './input2.js';
import type {Pt} from '../city-schema.js';

const PICK_PX = 9;
let size = {w: 800, h: 600};
export const setSize = (w: number, h: number) => { size = {w, h}; };

/** 격자·점 스냅. skip 은 자기 자신(드래그 중인 점) */
export function snapPoint(x: number, z: number, skip?: {road: string; idx: number}): Pt {
  if (ed.snapPts && ed.doc) {
    const tol = 10 / ed.view.scale;
    let best: Pt | null = null, bd = tol;
    const test = (p: Pt) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; best = p; } };
    for (const r of ed.doc.roads) r.pts.forEach((p, i) => { if (!(skip && skip.road === r.id && skip.idx === i)) test(p); });
    for (const n of ed.doc.nodes ?? []) test(n.at);
    for (const p of ed.draft) test(p);
    if (best) return [(best as Pt)[0], (best as Pt)[1]];
  }
  if (ed.snapGrid) return [round1(Math.round(x / ed.grid) * ed.grid), round1(Math.round(z / ed.grid) * ed.grid)];
  return [round1(x), round1(z)];
}

export function finishDraft() {
  if (ed.draft.length >= 2) {
    const pts = ed.draft.map(p => [p[0], p[1]] as Pt), cls = ed.drawCls, curve = ed.drawCurve, id = uniqueRoadId();
    mutate(roads => { roads.push({id, cls, pts, curve: pts.length < 3 ? 'line' : curve}); });
    select(id);
  }
  ed.draft = []; emit('ui');
}
export function cancelDraft() { ed.draft = []; emit('ui'); }

export function deleteSelection() {
  if (ed.selObj) { deleteObjSelection(); return; }
  const r = selected();
  if (!r) return;
  if (ed.selVert >= 0 && r.pts.length > 2) {
    const k = ed.selVert;
    let msg = '';
    mutateDoc(doc => {
      const len0 = lengthNow(r), c = ed.refs ? detachPointRefs(doc, r, k) : zeroCounts();
      removePoint(r, k);
      if (ed.refs) rescaleRoad(doc, r, len0, lengthNow(r));
      msg = summarize(c);
    });
    if (msg) setMsg(`점 삭제. ${msg}`);
    ed.selVert = -1; emit('sel');
  } else if (ed.selVert < 0) {
    let msg = '';
    mutateDoc(doc => {
      doc.roads.splice(doc.roads.indexOf(r), 1);
      if (ed.refs) msg = summarize(deleteRoadRefs(doc, r.id));
    });
    setMsg(`도로 ${r.id} 삭제. ${msg}`.trim());
    select(null);
  }
}
export function toggleCurve() {
  const r = selected();
  if (r) mutateDoc(doc => { const len0 = lengthNow(r); r.curve = r.curve === 'catmull' ? 'line' : 'catmull'; if (ed.refs) rescaleRoad(doc, r, len0, lengthNow(r)); });
}
export function setClass(cls: string) {
  const r = selected();
  if (r && r.cls !== cls) mutate(() => { r.cls = cls as typeof r.cls; });
}
/** 도로 위의 점 world(x,z)에 정점 삽입 */
export function insertAt(x: number, z: number) {
  const r = selected();
  if (!r) return false;
  const n = nearest(r, x, z);
  if (n.d > PICK_PX / ed.view.scale * 1.5) return false;
  const i = segIndexAt(r, n.j), p = snapPoint(n.x, n.z);
  mutateDoc(doc => { const len0 = lengthNow(r); insertPoint(r, i, p); if (ed.refs) rescaleRoad(doc, r, len0, lengthNow(r)); });
  select(r.id, i + 1);
  return true;
}

export function bindCanvas(cv: HTMLCanvasElement) {
  let pan: {sx: number; sy: number; cx: number; cz: number} | null = null;
  type RDrag = {road: string; idx: number; started: boolean; linked: Array<{road: string; idx: number}>; prev: Pt; len0: Map<string, number>};
  let drag: RDrag | null = null;
  let space = false;
  const pos = (e: MouseEvent): [number, number] => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const world = (e: MouseEvent) => { const [sx, sy] = pos(e); return toWorld(size.w, size.h, sx, sy); };

  cv.addEventListener('mousedown', e => {
    if (!ed.doc) return;
    const [wx, wz] = world(e), tol = PICK_PX / ed.view.scale;
    if (e.button === 1 || e.button === 2 || space) { pan = {sx: e.clientX, sy: e.clientY, cx: ed.view.cx, cz: ed.view.cz}; e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (ed.tool === 'zone' || ed.tool === 'anchor' || ed.tool === 'building' || ed.tool === 'brush') { toolDown(wx, wz, snapPoint, {alt: e.altKey, shift: e.shiftKey}); return; }
    if (ed.tool === 'draw') {
      const p = snapPoint(wx, wz), last = ed.draft[ed.draft.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.05) ed.draft.push(p);
      emit('ui'); return;
    }
    const sel = selected();
    if (sel) {
      const vi = hitVertex(sel, wx, wz, tol);
      if (vi >= 0) {
        select(sel.id, vi);
        const linked = ed.refs && ed.doc ? coincident(ed.doc, sel.pts[vi]) : [{road: sel.id, idx: vi}];
        drag = {road: sel.id, idx: vi, started: false, linked, prev: [sel.pts[vi][0], sel.pts[vi][1]], len0: new Map()};
        return;
      }
    }
    if (selDown(wx, wz, tol, 'pre')) return;
    const hit = hitRoad(wx, wz, tol);
    if (hit) { select(hit.id); return; }
    if (selDown(wx, wz, tol, 'post')) return;
    select(null);
    pan = {sx: e.clientX, sy: e.clientY, cx: ed.view.cx, cz: ed.view.cz};
  });
  window.addEventListener('mousemove', e => {
    const b = cv.getBoundingClientRect();
    if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) {
      const [wx, wz] = world(e);
      setHover(ed.tool === 'draw' || ed.tool === 'anchor' || ed.tool === 'building' ? snapPoint(wx, wz) : [wx, wz]); emit('view');
    }
    if (ed.alt !== e.altKey) { ed.alt = e.altKey; emit('view'); }
    if (dragging()) { const [wx, wz] = world(e); objMove(wx, wz, snapPoint); return; }
    if (pan) {
      ed.view.cx = pan.cx - (e.clientX - pan.sx) / ed.view.scale; ed.view.cz = pan.cz - (e.clientY - pan.sy) / ed.view.scale; emit('view');
    } else if (drag) {
      const r = roadById(drag.road);
      if (!r) return;
      const [wx, wz] = world(e), p = snapPoint(wx, wz, {road: drag.road, idx: drag.idx});
      if (!drag.started) {
        if (Math.hypot(r.pts[drag.idx][0] - p[0], r.pts[drag.idx][1] - p[1]) < 0.05) return;
        pushUndo(); drag.started = true;
        for (const l of drag.linked) { const lr = roadById(l.road); if (lr && !drag.len0.has(l.road)) drag.len0.set(l.road, lengthNow(lr)); }
      }
      for (const l of drag.linked) { const lr = roadById(l.road); if (lr && lr.pts[l.idx]) lr.pts[l.idx] = [p[0], p[1]]; }
      if (ed.refs && ed.doc) moveNodesAt(ed.doc, drag.linked.map(l => l.road), drag.prev, p);
      drag.prev = p; touched('geom');
    }
  });
  window.addEventListener('mouseup', () => {
    if (objUp()) { pan = null; return; }
    if (drag?.started) {
      if (ed.refs && ed.doc) for (const [id, len0] of drag.len0) { const lr = roadById(id); if (lr) rescaleRoad(ed.doc, lr, len0, lengthNow(lr)); }
      runAfterEdit(); touched('doc');
    }
    drag = null; pan = null;
  });
  cv.addEventListener('dblclick', e => {
    if (!ed.doc) return;
    if (ed.tool === 'draw') { finishDraft(); return; }
    const [wx, wz] = world(e);
    if (objDbl(wx, wz, PICK_PX / ed.view.scale)) return;
    if (selected() && hitVertex(selected()!, wx, wz, PICK_PX / ed.view.scale) < 0) insertAt(wx, wz);
  });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keyup', e => { if (e.code === 'Space') space = false; });
  window.addEventListener('keydown', e => {
    const t = e.target as HTMLElement;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    if (e.code === 'Space') { space = true; e.preventDefault(); }
  });
}
