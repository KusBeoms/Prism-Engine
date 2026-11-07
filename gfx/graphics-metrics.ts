// Frame counters for r128: scene and optional passes are measured independently.
// GPU timing is deliberately not inferred from CPU/RAF timings.
export type GraphicsPass = 'scene' | 'shadow' | 'reflection' | 'cubemap' | 'postprocess';
export interface PassCounts {calls: number; triangles: number; lines: number; points: number}
export interface TargetSize {width: number; height: number}
export interface TargetDescriptor extends TargetSize {
  /** Byte size of one pixel for each color attachment, e.g. [4] for RGBA8. */
  colorBytes: number[];
  /** Depth/stencil attachment bytes per pixel; 0 if absent. */
  depthBytes?: number;
  /** Multisample count; 0/1 means a single-sample target. */
  samples?: number;
  /** 6 for a cube target; 1 for a normal target. */
  faces?: number;
}
const PASSES: GraphicsPass[] = ['scene', 'shadow', 'reflection', 'cubemap', 'postprocess'];
const zero = (): PassCounts => ({calls: 0, triangles: 0, lines: 0, points: 0});
const valid = (n: number) => Number.isFinite(n) ? Math.max(0, n) : 0;
const dimensions = (n: number) => Math.max(1, Math.floor(valid(n)));
export function graphicsTargetSize(cssWidth: number, cssHeight: number, dpr: number, renderScale = 1, passScale = 1): TargetSize {
  const scale = valid(dpr) * valid(renderScale) * valid(passScale);
  return {width: dimensions(cssWidth * scale), height: dimensions(cssHeight * scale)};
}
/** Estimate attachment storage, including the single-sample resolved color of an MSAA target.
 * It excludes driver overhead and mipmaps; callers supply actual allocation sizes. */
export function estimateTargetBytes(target: TargetDescriptor): number {
  const samples = Math.max(1, Math.floor(valid(target.samples ?? 1))),
    color = target.colorBytes.reduce((sum, n) => sum + valid(n), 0),
    depth = valid(target.depthBytes ?? 0), faces = Math.max(1, Math.floor(valid(target.faces ?? 1))),
    bytesPerPixel = samples > 1 ? color * (samples + 1) + depth * samples : color + depth;
  return dimensions(target.width) * dimensions(target.height) * faces * bytesPerPixel;
}

/** Called by the central renderer, once per active frame; pass callbacks are synchronous. */
export function createGraphicsMetrics(renderer: any) {
  const info = renderer.info, previousAutoReset = info.autoReset, shadow = renderer.shadowMap,
    originalShadow = shadow?.render, passes = Object.fromEntries(PASSES.map(p => [p, zero()])) as Record<GraphicsPass, PassCounts>,
    targets = new Map<string, TargetDescriptor>(), stack: {children: PassCounts}[] = [];
  let active = false, disposed = false;
  const counters = (): PassCounts => ({calls: info.render.calls, triangles: info.render.triangles,
    lines: info.render.lines, points: info.render.points});
  const add = (to: PassCounts, from: PassCounts) => {
    to.calls += from.calls; to.triangles += from.triangles; to.lines += from.lines; to.points += from.points;
  };
  function measure<T>(pass: GraphicsPass, run: () => T): T {
    if (!active || disposed) return run();
    const before = counters(), entry = {children: zero()}; stack.push(entry);
    try {return run();} finally {
      const after = counters(), total: PassCounts = {
        calls: Math.max(0, after.calls - before.calls), triangles: Math.max(0, after.triangles - before.triangles),
        lines: Math.max(0, after.lines - before.lines), points: Math.max(0, after.points - before.points),
      };
      stack.pop();
      const self: PassCounts = {calls: Math.max(0, total.calls - entry.children.calls),
        triangles: Math.max(0, total.triangles - entry.children.triangles),
        lines: Math.max(0, total.lines - entry.children.lines), points: Math.max(0, total.points - entry.children.points)};
      add(passes[pass], self);
      if (stack.length) add(stack[stack.length - 1].children, total);
    }
  }
  const shadowHook = function(this: any, ...args: any[]) {
    return measure('shadow', () => originalShadow.apply(this, args));
  };
  info.autoReset = false;
  if (originalShadow) shadow.render = shadowHook;
  function beginFrame() {
    if (disposed) return;
    info.reset(); PASSES.forEach(pass => Object.assign(passes[pass], zero()));
    stack.length = 0; active = true;
  }
  function snapshot() {
    const rt = [...targets].map(([id, descriptor]) => ({id, ...descriptor, colorBytes: [...descriptor.colorBytes], bytes: estimateTargetBytes(descriptor)}));
    return {passes: Object.fromEntries(PASSES.map(pass => [pass, {...passes[pass]}])) as Record<GraphicsPass, PassCounts>,
      renderTargets: rt, renderTargetBytes: rt.reduce((sum, t) => sum + t.bytes, 0),
      resources: {geometries: info.memory.geometries, textures: info.memory.textures}, gpuTimeMs: null};
  }
  function trackTarget(id: string, descriptor: TargetDescriptor) {targets.set(id, {...descriptor, colorBytes: [...descriptor.colorBytes]});}
  function untrackTarget(id: string) {targets.delete(id);}
  function dispose() {
    if (disposed) return;
    disposed = true; active = false; targets.clear();
    if (shadow?.render === shadowHook) shadow.render = originalShadow;
    info.autoReset = previousAutoReset;
  }
  return {beginFrame, measure, snapshot, trackTarget, untrackTarget, dispose};
}
