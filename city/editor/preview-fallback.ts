// three.js 를 쓸 수 없을 때의 대체 표시: 지형 격자 줄과 도로·건물·앵커를 2D 캔버스에 의사 3D(회전+기울임) 와이어로 그린다.
import type {PvData} from './preview-data.js';
import {CLS_COLOR} from './draw.js';

export function drawFallback(cv: HTMLCanvasElement, d: PvData, cam: {yaw: number; pitch: number; dist: number}) {
  const c = cv.getContext('2d')!, w = cv.width, h = cv.height, k = (Math.min(w, h) / (d.R * 2.4)) / cam.dist;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch), mid = (d.minY + d.maxY) / 2;
  const P = (x: number, y: number, z: number): [number, number] => {
    const rx = x * cy - z * sy, rz = x * sy + z * cy;
    return [w / 2 + rx * k, h / 2 + (rz * sp - (y - mid) * cp) * k];
  };
  c.fillStyle = '#101820'; c.fillRect(0, 0, w, h);
  const n = d.n, stride = Math.max(1, Math.floor(n / 40));
  c.lineWidth = 1;
  for (let j = 0; j <= n; j += stride) {
    c.beginPath();
    for (let i = 0; i <= n; i++) { const y = d.heights[j * (n + 1) + i], [sx, sy2] = P(d.x0 + i * d.step - d.cx, y, d.z0 + j * d.step - d.cz); if (i) c.lineTo(sx, sy2); else c.moveTo(sx, sy2); }
    c.strokeStyle = 'rgba(120,170,120,.55)'; c.stroke();
  }
  for (const r of d.roads) {
    c.beginPath();
    for (let i = 0; i < r.xyz.length; i += 3) { const [sx, sy2] = P(r.xyz[i] - d.cx, r.xyz[i + 1] + 0.3, r.xyz[i + 2] - d.cz); if (i) c.lineTo(sx, sy2); else c.moveTo(sx, sy2); }
    c.strokeStyle = CLS_COLOR[r.cls] ?? '#ccc'; c.lineWidth = 2.2; c.stroke();
  }
  c.lineWidth = 1; c.strokeStyle = '#ddd';
  for (const b of d.buildings) {
    const [bx, by] = P(b.x - d.cx, b.y, b.z - d.cz), [tx, ty] = P(b.x - d.cx, b.y + b.h, b.z - d.cz);
    c.beginPath(); c.moveTo(bx, by); c.lineTo(tx, ty); c.stroke(); c.fillStyle = '#e8c9a0'; c.fillRect(tx - 2, ty - 2, 4, 4);
  }
  for (const a of d.anchors) { const [sx, sy2] = P(a.x - d.cx, a.y, a.z - d.cz); c.beginPath(); c.arc(sx, sy2, 3.5, 0, 7); c.fillStyle = a.fixed ? '#e33' : '#fff'; c.fill(); }
}
