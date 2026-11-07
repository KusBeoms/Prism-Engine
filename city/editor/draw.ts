// 캔버스 렌더링(2D). 색은 tools/city-author-preview.mjs 의 CLS_STYLE·ZONE_FILL 을 따른다.
import {dense, roadWidthM} from './roadops.js';
import {ed, roadById} from './state.js';
import type {RoadSource} from '../city-schema.js';
import {drawZoneLabels} from './names.js';
import {drawScaleBar} from './view.js';
import {drawAnchorDirs, drawBuildings, drawHeight, drawSelection, drawSlope, drawTools} from './draw2.js';

export const CLS_COLOR: Record<string, string> = {expressway: '#ee8a2b', arterial1: '#fbe83a', arterial2: '#3fb985', collector: '#6fd1a2', local: '#9a5bdc'};
export const CLS_LABEL: Record<string, string> = {expressway: '고속', arterial1: '주간선', arterial2: '보조간선', collector: '집산', local: '국지'};
export const ZONE_FILL: Record<string, string> = {residential: '#f4a77d', commercial: '#f2d35b', office: '#8aa7e8', industrial: '#a39b94', civic: '#d98bd0', park: '#66c26b', nature: '#2f8f4a', farm: '#c9d65e', water: '#4aa3df'};

export const toScreen = (w: number, h: number, x: number, z: number): [number, number] => [(x - ed.view.cx) * ed.view.scale + w / 2, (z - ed.view.cz) * ed.view.scale + h / 2];
export const toWorld = (w: number, h: number, sx: number, sz: number): [number, number] => [(sx - w / 2) / ed.view.scale + ed.view.cx, (sz - h / 2) / ed.view.scale + ed.view.cz];

export function roadPath(c: CanvasRenderingContext2D, w: number, h: number, r: RoadSource) {
  const d = dense(r);
  c.beginPath();
  for (let i = 0; i < d.n; i++) { const [sx, sy] = toScreen(w, h, d.x[i], d.z[i]); if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy); }
}
function poly(c: CanvasRenderingContext2D, w: number, h: number, pts: number[][]) {
  c.beginPath();
  pts.forEach((p, i) => { const [sx, sy] = toScreen(w, h, p[0], p[1]); if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy); });
  c.closePath();
}
function drawGrid(c: CanvasRenderingContext2D, w: number, h: number) {
  let step = ed.grid;
  while (step * ed.view.scale < 12) step *= 2;
  const [x0, z0] = toWorldTL(w, h), x1 = x0 + w / ed.view.scale, z1 = z0 + h / ed.view.scale;
  c.lineWidth = 1;
  for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
    const sx = toScreen(w, h, x, 0)[0]; c.strokeStyle = x % (step * 10) === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.06)';
    c.beginPath(); c.moveTo(sx, 0); c.lineTo(sx, h); c.stroke();
  }
  for (let z = Math.floor(z0 / step) * step; z <= z1; z += step) {
    const sy = toScreen(w, h, 0, z)[1]; c.strokeStyle = z % (step * 10) === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.06)';
    c.beginPath(); c.moveTo(0, sy); c.lineTo(w, sy); c.stroke();
  }
}
const toWorldTL = (w: number, h: number) => toWorld(w, h, 0, 0);

export function draw(c: CanvasRenderingContext2D, w: number, h: number) {
  c.fillStyle = '#10161d'; c.fillRect(0, 0, w, h);
  const doc = ed.doc;
  if (!doc) return;
  const k = ed.view.scale;
  const ts = (x: number, z: number) => toScreen(w, h, x, z);
  if (ed.showHeight) drawHeight(c, ts, k);
  if (ed.snapGrid && ed.grid * k >= 3) drawGrid(c, w, h);
  if (Array.isArray(doc.bounds) && doc.bounds.length > 2) {
    poly(c, w, h, doc.bounds); c.fillStyle = 'rgba(70,90,110,.25)'; c.fill(); c.strokeStyle = '#7fa6c9'; c.lineWidth = 1.5; c.setLineDash([8, 5]); c.stroke(); c.setLineDash([]);
  }
  for (const z of doc.zones ?? []) {
    if (!Array.isArray(z.poly) || z.poly.length < 3) continue;
    poly(c, w, h, z.poly); c.globalAlpha = 0.38; c.fillStyle = ZONE_FILL[z.use] ?? '#888'; c.fill(); c.globalAlpha = 1;
    c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1; c.stroke();
  }
  drawBuildings(c, ts, k);
  const rejected = new Set((ed.compiled?.rejected ?? []).map(r => r.owner));
  c.lineJoin = 'round'; c.lineCap = 'butt';
  for (const r of doc.roads) {
    const wpx = Math.max(1.5, roadWidthM(r) * k);
    roadPath(c, w, h, r); c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = wpx + 2; c.stroke();
    roadPath(c, w, h, r); c.strokeStyle = CLS_COLOR[r.cls] ?? '#ccc'; c.lineWidth = wpx; c.globalAlpha = r.segments?.some(s => s.layer > 0) ? 0.75 : 1; c.stroke(); c.globalAlpha = 1;
    if (rejected.has(r.id)) { roadPath(c, w, h, r); c.strokeStyle = '#ff2d2d'; c.lineWidth = 2; c.setLineDash([5, 4]); c.stroke(); c.setLineDash([]); }
  }
  // 입체 램프: from/to 노드를 점선으로 잇는다
  const nodes = new Map((doc.nodes ?? []).map(n => [n.id, n]));
  c.strokeStyle = '#ffd24a'; c.lineWidth = 1.5; c.setLineDash([3, 3]);
  for (const rp of doc.ramps ?? []) {
    const a = nodes.get(rp.fromNode), b = nodes.get(rp.toNode);
    if (!a || !b) continue;
    const [ax, ay] = toScreen(w, h, a.at[0], a.at[1]), [bx, by] = toScreen(w, h, b.at[0], b.at[1]);
    c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
  }
  c.setLineDash([]);
  for (const n of doc.nodes ?? []) {
    const [sx, sy] = toScreen(w, h, n.at[0], n.at[1]);
    c.fillStyle = n.layer > 0 ? '#ffd24a' : n.kind === 'endpoint' ? '#f0f' : '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1;
    const s = n.layer > 0 ? 4 : 3;
    if (n.layer > 0) { c.beginPath(); c.moveTo(sx, sy - s - 1); c.lineTo(sx + s + 1, sy); c.lineTo(sx, sy + s + 1); c.lineTo(sx - s - 1, sy); c.closePath(); } else { c.beginPath(); c.arc(sx, sy, s, 0, 7); }
    c.fill(); c.stroke();
  }
  drawSlope(c, ts, k);
  for (const a of doc.anchors ?? []) {
    const [sx, sy] = toScreen(w, h, a.x, a.z);
    c.beginPath(); c.arc(sx, sy, a.fixed ? 6 : 4.5, 0, 7); c.fillStyle = a.fixed ? '#e33' : '#fff'; c.fill(); c.strokeStyle = '#000'; c.lineWidth = 1.2; c.stroke();
    if (k > 0.8) { c.font = '11px sans-serif'; c.lineWidth = 2.6; c.strokeStyle = '#000'; c.strokeText(a.id, sx + 8, sy + 4); c.fillStyle = '#fff'; c.fillText(a.id, sx + 8, sy + 4); }
  }
  drawAnchorDirs(c, ts); drawSelection(c, ts);
  const sel = roadById(ed.selRoad);
  if (sel) {
    roadPath(c, w, h, sel); c.strokeStyle = '#fff'; c.lineWidth = Math.max(1.5, roadWidthM(sel) * k) + 5; c.globalAlpha = 0.5; c.stroke(); c.globalAlpha = 1;
    roadPath(c, w, h, sel); c.strokeStyle = CLS_COLOR[sel.cls]; c.lineWidth = Math.max(1.5, roadWidthM(sel) * k); c.stroke();
    sel.pts.forEach((p, i) => {
      const [sx, sy] = toScreen(w, h, p[0], p[1]);
      c.beginPath(); c.rect(sx - 4.5, sy - 4.5, 9, 9); c.fillStyle = i === ed.selVert ? '#ff5a36' : '#fff'; c.fill(); c.strokeStyle = '#000'; c.lineWidth = 1.2; c.stroke();
    });
  }
  for (const s of ed.issues) {
    if (!s.at) continue;
    const [sx, sy] = toScreen(w, h, s.at[0], s.at[1]);
    c.beginPath(); c.arc(sx, sy, 9, 0, 7); c.strokeStyle = s.sev === 'error' ? '#ff3b3b' : '#ffa53b'; c.lineWidth = 2; c.stroke();
  }
  drawZoneLabels(c, ts);
  drawTools(c, ts, k, hover);
  if (ed.draft.length && ed.tool === 'draw') {
    c.beginPath(); ed.draft.forEach((p, i) => { const [sx, sy] = toScreen(w, h, p[0], p[1]); if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy); });
    if (hover) { const [sx, sy] = toScreen(w, h, hover[0], hover[1]); c.lineTo(sx, sy); }
    c.strokeStyle = CLS_COLOR[ed.drawCls]; c.lineWidth = 3; c.setLineDash([6, 4]); c.stroke(); c.setLineDash([]);
    for (const p of ed.draft) { const [sx, sy] = toScreen(w, h, p[0], p[1]); c.fillStyle = '#fff'; c.fillRect(sx - 3.5, sy - 3.5, 7, 7); }
  }
  drawScaleBar(c, h);
  if (hover && ed.tool === 'draw') { const [sx, sy] = toScreen(w, h, hover[0], hover[1]); c.strokeStyle = '#fff'; c.lineWidth = 1; c.beginPath(); c.arc(sx, sy, 5, 0, 7); c.stroke(); }
}
let hover: [number, number] | null = null;
export const setHover = (p: [number, number] | null) => { hover = p; };
export const getHover = () => hover;
