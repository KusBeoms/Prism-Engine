// Pure capability heuristic; touch alone is not a reliable measure of graphics performance.
export type DetectedProfile = 'desktop' | 'mobile';
export interface QualitySignals {coarse: boolean; width: number; height: number; memory?: number; cores?: number; renderer?: string}
export function detectQuality(s: QualitySignals): DetectedProfile {
  const small = Math.min(s.width || 9999, s.height || 9999) <= 820,
    weak = !!(s.memory && s.memory <= 4 || s.cores && s.cores <= 4),
    mobileGpu = /\b(mali|adreno|powervr|apple gpu)\b/i.test(s.renderer || '');
  return s.coarse && (small || weak || mobileGpu && small) ? 'mobile' : 'desktop';
}
export function browserQualitySignals(): QualitySignals {
  const nav: {deviceMemory?: number; hardwareConcurrency?: number} = typeof navigator === 'undefined' ? {} : navigator as Navigator & {deviceMemory?: number};
  return {coarse: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    width: typeof screen === 'undefined' ? 0 : screen.width, height: typeof screen === 'undefined' ? 0 : screen.height,
    memory: nav.deviceMemory, cores: nav.hardwareConcurrency};
}
