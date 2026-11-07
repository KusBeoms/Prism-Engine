// 도시 이름·구역 이름 편집과 지도 위 구역 라벨. 이름은 선택 항목이라 빈 문자열이면 필드를 지운다.
import type {Pt, ZoneSource} from '../city-schema.js';
import {ed, mutateDoc} from './state.js';

export const ZONE_NAME_MAX = 24;
export const CITY_NAME_MAX = 40;
const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** 도시 이름 변경(실행 취소 1단계). 같은 값이면 아무것도 하지 않는다 */
export function setCityName(v: string) {
  if (!ed.doc) return;
  const n = clean(v, CITY_NAME_MAX);
  if (n === (ed.doc.name ?? '')) return;
  mutateDoc(d => { if (n) d.name = n; else delete d.name; });
}
/** 구역 이름 변경(실행 취소 1단계) */
export function setZoneName(z: ZoneSource, v: string) {
  const n = clean(v, ZONE_NAME_MAX);
  if (n === (z.name ?? '')) return;
  mutateDoc(() => { if (n) z.name = n; else delete z.name; });
}

/** 다각형 면적 무게중심(퇴화하면 꼭짓점 평균) */
export function labelPos(poly: Pt[]): Pt {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-6) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return [cx / (3 * a), cz / (3 * a)];
}

/** 마지막으로 그린 라벨(시험·디버그용) */
export const drawnLabels: Array<{id: string; name: string; sx: number; sy: number}> = [];
export function drawZoneLabels(c: CanvasRenderingContext2D, ts: (x: number, z: number) => [number, number]) {
  drawnLabels.length = 0;
  if (!ed.showZoneNames) return;
  c.font = 'bold 13px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  for (const z of ed.doc?.zones ?? []) {
    if (!z.name || !Array.isArray(z.poly) || z.poly.length < 3) continue;
    const [sx, sy] = ts(...labelPos(z.poly));
    c.lineWidth = 3.5; c.strokeStyle = 'rgba(0,0,0,.8)'; c.strokeText(z.name, sx, sy);
    c.fillStyle = '#fff'; c.fillText(z.name, sx, sy);
    drawnLabels.push({id: z.id, name: z.name, sx, sy});
  }
  c.textAlign = 'start'; c.textBaseline = 'alphabetic';
}
