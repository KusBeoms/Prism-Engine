// 시점 조작(맥북 트랙패드 우선) + 척도 바.
//  두 손가락 스와이프 = ctrlKey 없는 wheel 의 deltaX/deltaY → 이동 / 핀치 = Chrome·Firefox 는 ctrlKey+wheel, Safari 는 gesture* 이벤트 → 커서 기준 확대.
//  휠 마우스(deltaMode≠0 이거나 100 단위의 큰 델타)는 커서 기준 부드러운 확대. ⌥+스크롤은 항상 확대.
import {ed, emit} from './state.js';

const MIN_SCALE = 0.04, MAX_SCALE = 60;
const LINE_PX = 33; // 줄 단위 휠 1칸 ≈ 33px (3줄 ≈ 100px = 일반 마우스 한 칸)
let size = {w: 800, h: 600};
export const setViewSize = (w: number, h: number) => { size = {w, h}; };

const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
/** 화면 좌표 (sx, sy) 의 월드 점이 제자리에 있도록 scale 을 바꾼다 */
export function zoomAt(sx: number, sy: number, next: number) {
  const v = ed.view, wx = (sx - size.w / 2) / v.scale + v.cx, wz = (sy - size.h / 2) / v.scale + v.cz;
  v.scale = clampScale(next);
  v.cx = wx - (sx - size.w / 2) / v.scale; v.cz = wz - (sy - size.h / 2) / v.scale;
  emit('view');
}
/** deltaMode 를 픽셀로 */
export function pixelDelta(e: {deltaX: number; deltaY: number; deltaMode: number}): [number, number] {
  const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? size.h : 1;
  return [e.deltaX * k, e.deltaY * k];
}
let lastTrackpadAt = 0;
/** 휠 마우스인가? (트랙패드는 작은 델타가 연속으로 오고 deltaX 가 섞인다) */
export function looksLikeMouseWheel(e: WheelEvent, now = performance.now()): boolean {
  if (e.deltaMode !== 0) return true;
  if (e.deltaX !== 0) { lastTrackpadAt = now; return false; }
  const wd = (e as WheelEvent & {wheelDeltaY?: number}).wheelDeltaY;
  const big = Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 100 && (wd === undefined || wd % 120 === 0);
  if (big && now - lastTrackpadAt > 120) return true;
  lastTrackpadAt = now;
  return false;
}

// ── 부드러운 확대(휠 마우스): 목표 배율로 매 프레임 다가간다 ──
let anim: {sx: number; sy: number; target: number} | null = null, animOn = false;
function step() {
  if (!anim) { animOn = false; return; }
  const cur = ed.view.scale, d = anim.target - cur;
  if (Math.abs(d) / cur < 0.002) { zoomAt(anim.sx, anim.sy, anim.target); anim = null; animOn = false; return; }
  zoomAt(anim.sx, anim.sy, cur + d * 0.35);
  requestAnimationFrame(step);
}
function smoothZoom(sx: number, sy: number, factor: number) {
  const base = anim ? anim.target : ed.view.scale;
  anim = {sx, sy, target: clampScale(base * factor)};
  if (!animOn) { animOn = true; requestAnimationFrame(step); }
}
export function stopZoomAnim() { anim = null; }

export function bindView(cv: HTMLCanvasElement) {
  const pos = (e: {clientX: number; clientY: number}): [number, number] => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  // 브라우저 기본 페이지 확대(ctrl+wheel, Safari gesture)는 에디터 어디서든 막는다. 3D 미리보기 소창은 제외
  window.addEventListener('wheel', e => { if (e.ctrlKey && !(e.target as HTMLElement | null)?.closest?.('#pv')) e.preventDefault(); }, {passive: false});
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, e => e.preventDefault(), {passive: false} as AddEventListenerOptions);

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const [sx, sy] = pos(e), [dx, dy] = pixelDelta(e);
    if (e.ctrlKey) { // 핀치(트랙패드) 또는 Ctrl+휠: 델타가 작아서 지수 감도를 크게
      stopZoomAnim();
      zoomAt(sx, sy, ed.view.scale * Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.012));
    } else if (e.altKey || looksLikeMouseWheel(e)) {
      smoothZoom(sx, sy, Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0016));
    } else { // 두 손가락 스와이프 = 스크롤 이동
      stopZoomAnim();
      ed.view.cx += dx / ed.view.scale; ed.view.cz += dy / ed.view.scale; emit('view');
    }
  }, {passive: false});

  // Safari 핀치: gesturestart 때 배율을 기억하고 e.scale(누적 비율)을 곱한다
  let g0 = 1;
  type G = Event & {scale: number; clientX: number; clientY: number};
  cv.addEventListener('gesturestart', e => { e.preventDefault(); stopZoomAnim(); g0 = ed.view.scale; });
  cv.addEventListener('gesturechange', e => { e.preventDefault(); const g = e as G, [sx, sy] = pos(g); zoomAt(sx, sy, g0 * (g.scale || 1)); });
  cv.addEventListener('gestureend', e => e.preventDefault());
}

// ───────── 척도 바 ─────────
const NICE = [1, 2, 5];
/** 현재 배율(px/m)에서 보기 좋은 길이. 바 길이는 maxPx 이하 중 가장 긴 것 */
export function scaleBar(scale = ed.view.scale, maxPx = 150): {m: number; px: number; label: string} {
  let best = 1;
  for (let e = -2; e <= 6; e++) for (const n of NICE) { const m = n * Math.pow(10, e); if (m * scale <= maxPx && m > best) best = m; }
  if (best * scale > maxPx) best = Math.pow(10, -2);
  const label = best >= 1000 ? `${+(best / 1000).toFixed(2)} km` : `${+best.toFixed(2)} m`;
  return {m: best, px: best * scale, label};
}
export function drawScaleBar(c: CanvasRenderingContext2D, h: number) {
  const b = scaleBar(), x = 16, y = h - 18;
  c.save();
  c.font = '12px system-ui, sans-serif';
  const tw = c.measureText(b.label).width, w = Math.max(b.px, tw) + 16;
  c.fillStyle = 'rgba(16,22,29,.78)'; c.fillRect(x - 8, y - 26, w, 38);
  c.strokeStyle = '#e8eef5'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(x, y - 6); c.lineTo(x, y); c.lineTo(x + b.px, y); c.lineTo(x + b.px, y - 6); c.stroke();
  c.fillStyle = '#e8eef5'; c.fillText(b.label, x, y - 11);
  c.restore();
}
