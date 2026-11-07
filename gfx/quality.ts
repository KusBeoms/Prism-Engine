// Graphics choices: URL override > explicitly saved choice > capability detection.
// No game or input imports: the renderer can read the effective profile during initialization.
import {browserQualitySignals, detectQuality} from './quality-detect.js';
export type Profile = 'desktop' | 'mobile' | 'power';
export type GfxChoice = 'auto' | Profile;
export interface Quality {
  profile: Profile; source: 'url' | 'saved' | 'auto'; pixelRatioMax: number;
  clouds: number; resolutionScale: number; shadows: boolean; postprocessing: boolean;
  adaptiveLevel: number;
}
const validChoice = (value: unknown): GfxChoice =>
  value === 'desktop' || value === 'mobile' || value === 'power' ? value : 'auto';
function urlChoice(): Profile | null {
  try {const c = validChoice(new URLSearchParams(location.search).get('gfx')); return c === 'auto' ? null : c;}
  catch {return null;}
}
/** Old releases saved a local-only gfx key. The caller may migrate it to the game save once. */
export function takeLegacyGfxChoice(): GfxChoice | null {
  try {
    const raw = localStorage.getItem('gfx');
    if (raw === 'desktop' || raw === 'mobile' || raw === 'power') {
      localStorage.removeItem('gfx'); return raw;
    }
  } catch { /* storage unavailable */ }
  return null;
}
function legacyChoice(): GfxChoice {
  try {return validChoice(localStorage.getItem('gfx'));} catch {return 'auto';}
}
let choice: GfxChoice = legacyChoice();
const listeners = new Set<(quality: Quality) => void>(), choices = new Set<(choice: GfxChoice) => void>();
export const Q: Quality = {profile: 'desktop', source: 'auto', pixelRatioMax: 2, clouds: 28,
  resolutionScale: 1, shadows: true, postprocessing: true, adaptiveLevel: 0};
function applyChoice() {
  const forced = urlChoice(), profile = forced || (choice === 'auto' ? detectQuality(browserQualitySignals()) : choice);
  Object.assign(Q, {profile, source: forced ? 'url' : choice === 'auto' ? 'auto' : 'saved',
    pixelRatioMax: profile === 'desktop' ? 2 : profile === 'mobile' ? 1.5 : 1,
    clouds: profile === 'desktop' ? 28 : profile === 'mobile' ? 16 : 8,
    resolutionScale: 1, shadows: true, postprocessing: true, adaptiveLevel: 0});
  listeners.forEach(fn => fn(Q));
}
export function getGfxChoice(): GfxChoice {return choice;}
/** Server/local load; never publishes a user action or saves the detected profile. */
export function hydrateGfxChoice(value: unknown) {choice = validChoice(value); applyChoice();}
export function setGfxChoice(value: GfxChoice) {
  choice = validChoice(value); applyChoice(); choices.forEach(fn => fn(choice));
}
export function onQualityChange(fn: (quality: Quality) => void) {listeners.add(fn); return () => listeners.delete(fn);}
export function onGfxChoice(fn: (choice: GfxChoice) => void) {choices.add(fn); return () => choices.delete(fn);}
/** Update transient quality only: no save and no automatic promotion. */
export function lowerQuality(): boolean {
  if (Q.source === 'url') return false;
  if (Q.adaptiveLevel === 0) {Q.resolutionScale = 0.75; Q.adaptiveLevel = 1;}
  else if (Q.shadows) {Q.shadows = false; Q.adaptiveLevel = 2;}
  else if (Q.postprocessing) {Q.postprocessing = false; Q.adaptiveLevel = 3;}
  else return false;
  listeners.forEach(fn => fn(Q)); return true;
}
/** Backward-compatible API for callers from older builds. New UI uses setGfxChoice. */
export function saveGfx(p: Profile | null) {setGfxChoice(p || 'auto');}
applyChoice();
