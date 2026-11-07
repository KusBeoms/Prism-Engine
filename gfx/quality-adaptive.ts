// Monotonic requestAnimationFrame timestamps, independent of capped game dt and pause dt.
import {lowerQuality, onGfxChoice, Q} from './quality.js';
const WINDOW_MS = 3000, SETTLE_MS = 2000, COOLDOWN_MS = 10000;
let samples: number[] = [], settleUntil = 0, cooldownUntil = 0, previous = 0;
/** Call after startup, visibility restoration, resize and context restoration. */
export function resetAdaptiveSampling(now = performance.now()) {
  samples = []; previous = 0; settleUntil = now + SETTLE_MS;
}
onGfxChoice(() => {cooldownUntil = 0; resetAdaptiveSampling();});
/** Returns true only when a real, currently supported setting was lowered. */
export function updateAdaptiveQuality(now: number, active = true): boolean {
  if (!Number.isFinite(now)) return false;
  if (!active || typeof document !== 'undefined' && document.hidden) {resetAdaptiveSampling(now); return false;}
  if (Q.source === 'url') {samples = []; previous = now; return false;}
  if (previous && (now <= previous || now - previous > 1000)) {resetAdaptiveSampling(now); return false;}
  previous = now;
  if (now < settleUntil || now < cooldownUntil) return false;
  samples.push(now);
  while (samples.length > 1 && samples[1] <= now - WINDOW_MS) samples.shift();
  const span = now - samples[0];
  if (span < WINDOW_MS || (samples.length - 1) * 1000 / span >= 30) return false;
  samples = [];
  if (!lowerQuality()) return false;
  cooldownUntil = now + COOLDOWN_MS;
  return true;
}
resetAdaptiveSampling();
