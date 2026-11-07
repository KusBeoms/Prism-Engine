// 캔버스 추가 레이어: 높이 이미지, 건물, 선택 객체 핸들, 앵커 방향, 경사 초과 구간, 구역·브러시 그리기 미리보기.
import {bldCorners} from './objops.js';
import {dense} from './roadops.js';
import {ed, objOf} from './state.js';
import {allGradeHits, heightImage} from './terrain-ed.js';
import type {AnchorSource, BuildingSource, NodeSource, Pt, ZoneSource} from '../city-schema.js';

export type ToScreen = (x: number, z: number) => [number, number];
const ZONE_FILL: Record<string, string> = {residential: '#f4a77d', commercial: '#f2d35b', office: '#8aa7e8', industrial: '#a39b94', civic: '#d98bd0', park: '#66c26b', nature: '#2f8f4a', farm: '#c9d65e', water: '#4aa3df'};
const BLD_FILL: Record<string, string> = {house: '#e8c9a0', shop: '#f0b86e', apartment: '#b9a6e8', office: '#8fb8e8', highrise: '#7aa0d8', civic: '#e0a0c8', barn: '#c8946a', lodge: '#b08a5a', landmark: '#ffd24a'};
/** 앵커 방향 표시 길이(px). 입력 처리도 같은 값을 쓴다 */
export const ROT_HANDLE_PX = 26;

export function drawHeight(c: CanvasRenderingContext2D, ts: ToScreen, k: number) {
  const hi = heightImage();
  if (!hi) return;
  const {cv, t} = hi, [x, y] = ts(t.x0 - t.cell / 2, t.z0 - t.cell / 2);
  c.save(); c.imageSmoothingEnabled = false; c.globalAlpha = 0.85;
  c.drawImage(cv, x, y, t.cols * t.cell * k, t.rows * t.cell * k);
  c.restore();
}
const path = (c: CanvasRenderingContext2D, ts: ToScreen, pts: ArrayLike<number>[] | Pt[], close: boolean) => {
  c.beginPath();
  (pts as Pt[]).forEach((p, i) => { const [sx, sy] = ts(p[0], p[1]); if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy); });
  if (close) c.closePath();
};
export function drawBuildings(c: CanvasRenderingContext2D, ts: ToScreen, k: number) {
  for (const b of ed.doc?.buildings ?? []) {
    if (!(b.w > 0 && b.d > 0)) continue;
    const cs = bldCorners(b);
    path(c, ts, cs, true); c.fillStyle = BLD_FILL[b.style] ?? '#ccc'; c.globalAlpha = 0.9; c.fill(); c.globalAlpha = 1;
    c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke();
    // 문: 정면(s=+z) 가장자리 중점에 짧은 막대
    const dr = b.interior?.door;
    if (dr) {
      const o = {cx: b.x, cz: b.z, rot: b.rot}, cos = Math.cos(o.rot * Math.PI / 180), sin = Math.sin(o.rot * Math.PI / 180);
      const wx = o.cx + cos * dr.x + sin * dr.z, wz = o.cz - sin * dr.x + cos * dr.z, [sx, sy] = ts(wx, wz);
      c.fillStyle = '#c33'; c.fillRect(sx - 2.5, sy - 2.5, 5, 5);
    }
    if (k > 1.5) { const [sx, sy] = ts(b.x, b.z); c.font = '10px sans-serif'; c.fillStyle = '#000'; c.fillText(`${b.id} ${b.floors}F`, sx - 14, sy + 3); }
  }
}
export function drawSlope(c: CanvasRenderingContext2D, ts: ToScreen, k: number) {
  if (!ed.showSlope) return;
  const roads = new Map((ed.doc?.roads ?? []).map(r => [r.id, r]));
  c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
  for (const h of allGradeHits()) {
    const r = roads.get(h.road);
    if (!r) continue;
    const d = dense(r);
    c.beginPath(); let first = true;
    for (let i = 0; i < d.n; i++) { if (d.s[i] < h.s0 - 1 || d.s[i] > h.s1 + 1) continue; const [sx, sy] = ts(d.x[i], d.z[i]); if (first) { c.moveTo(sx, sy); first = false; } else c.lineTo(sx, sy); }
    c.strokeStyle = 'rgba(255,40,40,.8)'; c.lineWidth = Math.max(4, 8 * Math.min(1, k + 0.3)); c.stroke();
  }
  c.restore();
}
const sq = (c: CanvasRenderingContext2D, sx: number, sy: number, on: boolean) => { c.beginPath(); c.rect(sx - 4.5, sy - 4.5, 9, 9); c.fillStyle = on ? '#ff5a36' : '#fff'; c.fill(); c.strokeStyle = '#000'; c.lineWidth = 1.2; c.stroke(); };
export function drawSelection(c: CanvasRenderingContext2D, ts: ToScreen) {
  const s = ed.selObj;
  if (!s) return;
  const o = objOf(s);
  if (!o) return;
  if (s.kind === 'zone') {
    const z = o as ZoneSource;
    path(c, ts, z.poly, true); c.strokeStyle = '#fff'; c.lineWidth = 2.5; c.stroke();
    z.poly.forEach((p, i) => { const [sx, sy] = ts(p[0], p[1]); sq(c, sx, sy, i === s.vert); });
  } else if (s.kind === 'building') {
    path(c, ts, bldCorners(o as BuildingSource), true); c.strokeStyle = '#ff9a2b'; c.lineWidth = 3; c.stroke();
  } else if (s.kind === 'node') {
    const [sx, sy] = ts((o as NodeSource).at[0], (o as NodeSource).at[1]);
    c.beginPath(); c.arc(sx, sy, 9, 0, 7); c.strokeStyle = '#ff9a2b'; c.lineWidth = 3; c.stroke();
  } else if (s.kind === 'anchor') {
    const a = o as AnchorSource, [sx, sy] = ts(a.x, a.z), r = (a.rot ?? 0) * Math.PI / 180;
    c.beginPath(); c.arc(sx, sy, 10, 0, 7); c.strokeStyle = '#ff9a2b'; c.lineWidth = 3; c.stroke();
    const hx = sx + Math.sin(r) * ROT_HANDLE_PX, hy = sy + Math.cos(r) * ROT_HANDLE_PX;
    c.beginPath(); c.moveTo(sx, sy); c.lineTo(hx, hy); c.strokeStyle = '#ff9a2b'; c.lineWidth = 2; c.stroke();
    c.beginPath(); c.arc(hx, hy, 5, 0, 7); c.fillStyle = '#ff9a2b'; c.fill(); c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke();
  }
}
/** 앵커마다 방향 눈금(rot 가 있을 때) */
export function drawAnchorDirs(c: CanvasRenderingContext2D, ts: ToScreen) {
  c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5;
  for (const a of ed.doc?.anchors ?? []) {
    if (!a.rot) continue;
    const [sx, sy] = ts(a.x, a.z), r = a.rot * Math.PI / 180;
    c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + Math.sin(r) * 14, sy + Math.cos(r) * 14); c.stroke();
  }
}
export function drawTools(c: CanvasRenderingContext2D, ts: ToScreen, k: number, hover: [number, number] | null) {
  if (ed.tool === 'zone') {
    const erase = ed.zmode ? ed.zmode === 'erase' : ed.alt, col = erase ? '#ff4d4d' : ZONE_FILL[ed.zmode ? ed.zmodeUse : ed.zoneUse];
    if (ed.stroke.length) { path(c, ts, ed.stroke, false); c.strokeStyle = col; c.lineWidth = Math.max(2, ed.zbr * 2 * k); c.globalAlpha = 0.38; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(); c.globalAlpha = 1; c.lineCap = 'butt'; }
    if (hover) { const [sx, sy] = ts(hover[0], hover[1]); c.beginPath(); c.arc(sx, sy, ed.zbr * k, 0, 7); c.strokeStyle = col; c.lineWidth = 2; if (erase) c.setLineDash([5, 4]); c.stroke(); c.setLineDash([]); }
  }
  if (ed.tool === 'brush') {
    if (ed.stroke.length) { path(c, ts, ed.stroke, false); c.strokeStyle = ed.brush.mode === 'raise' ? '#ff9a2b' : ed.brush.mode === 'lower' ? '#4aa3df' : '#bbb'; c.lineWidth = Math.max(2, ed.brush.r * 2 * k); c.globalAlpha = 0.28; c.lineCap = 'round'; c.stroke(); c.globalAlpha = 1; c.lineCap = 'butt'; }
    if (hover) { const [sx, sy] = ts(hover[0], hover[1]); c.beginPath(); c.arc(sx, sy, ed.brush.r * k, 0, 7); c.strokeStyle = '#fff'; c.lineWidth = 1.2; c.stroke(); }
  }
  if ((ed.tool === 'anchor' || ed.tool === 'building') && hover) {
    const [sx, sy] = ts(hover[0], hover[1]);
    if (ed.tool === 'anchor') { c.beginPath(); c.arc(sx, sy, 6, 0, 7); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke(); }
    else { const b = ed.bld, hw = b.w / 2 * k, hd = b.d / 2 * k; c.save(); c.translate(sx, sy); c.rotate(-b.rot * Math.PI / 180); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.setLineDash([4, 3]); c.strokeRect(-hw, -hd, hw * 2, hd * 2); c.restore(); }
  }
}
