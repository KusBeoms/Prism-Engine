// One planar reflection capture for the nearest visible sea or lake; the water shader consumes
// the returned world-space projection matrix and texture. No changes to the main camera.
import type {createGraphicsMetrics} from './graphics-metrics.js';

type Metrics = ReturnType<typeof createGraphicsMetrics>;
export type Point = {x: number; y: number; z: number};
export interface ReflectionFrame {texture: any; matrix: any; surface: string; level: number; width: number; height: number}
/** Game-supplied: picks the nearest reflective water surface (sea/lake) for a point, or null. */
export type SurfaceFinder = (p: Point) => {name: string; level: number} | null;

/** The caller invokes capture once before drawing the main scene, inside the current metrics frame.
 * Texture coordinates = matrix * vec4(worldPosition, 1), sample with texture2DProj.
 * Water meshes must not participate in the reflection render (prevents feedback/recursion). */
export function createPlanarReflection(renderer: any, scene: any, metrics: Metrics | undefined, nearestReflectiveSurface: SurfaceFinder) {
  const camera = new THREE.PerspectiveCamera(), normal = new THREE.Vector3(0, 1, 0), point = new THREE.Vector3(),
    cameraPos = new THREE.Vector3(), look = new THREE.Vector3(), targetPoint = new THREE.Vector3(),
    rotation = new THREE.Matrix4(), plane = new THREE.Plane(), clip = new THREE.Vector4(), q = new THREE.Vector4(),
    matrix = new THREE.Matrix4(), buffer = new THREE.Vector2(), viewport = new THREE.Vector4(), scissor = new THREE.Vector4();
  let target: any = null, busy = false, disposed = false;
  const waters = () => {
    const out: any[] = [], sea = scene.getObjectByName('sea'), lakes = scene.getObjectByName('lakes');
    if (sea) out.push(sea);
    if (lakes) lakes.traverse((o: any) => {if (o.isMesh && o.name.startsWith('lake:')) out.push(o);});
    return out;
  };
  function resize() {
    renderer.getDrawingBufferSize(buffer);
    const width = Math.max(1, Math.floor(buffer.x / 2)), height = Math.max(1, Math.floor(buffer.y / 2));
    if (!target) {
      target = new THREE.WebGLRenderTarget(width, height, {minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false});
      target.texture.generateMipmaps = false;
      target.texture.encoding = THREE.LinearEncoding;
    } else if (target.width !== width || target.height !== height) target.setSize(width, height);
    metrics?.trackTarget('planar-reflection', {width, height, colorBytes: [4], depthBytes: 4});
  }
  function capture(source: any, player: Point, enabled = true): ReflectionFrame | null {
    if (disposed || busy || !enabled || !source?.isPerspectiveCamera) return null;
    const active = nearestReflectiveSurface(player), list = waters(), selected = active && list.find(o => o.name === active.name);
    if (!active || !selected || !selected.visible) return null;
    source.updateMatrixWorld(); cameraPos.setFromMatrixPosition(source.matrixWorld);
    if (cameraPos.y <= active.level + 0.05) return null;
    resize();
    point.set(0, active.level, 0);
    camera.position.copy(cameraPos); camera.position.y = 2 * active.level - cameraPos.y;
    rotation.extractRotation(source.matrixWorld);
    look.set(0, 0, -1).applyMatrix4(rotation).add(cameraPos);
    targetPoint.copy(look); targetPoint.y = 2 * active.level - look.y;
    camera.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal);
    camera.lookAt(targetPoint); camera.near = source.near; camera.far = source.far;
    camera.updateMatrixWorld(); camera.projectionMatrix.copy(source.projectionMatrix);
    matrix.set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1)
      .multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
    // Oblique near plane prevents geometry below the selected water surface from leaking into reflections.
    plane.setFromNormalAndCoplanarPoint(normal, point).applyMatrix4(camera.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = camera.projectionMatrix.elements;
    q.set((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    const dot = clip.dot(q);
    if (Math.abs(dot) < 1e-7) return null;
    clip.multiplyScalar(2 / dot); e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - .003; e[14] = clip.w;
    const priorTarget = renderer.getRenderTarget(), priorFace = renderer.getActiveCubeFace(), priorMip = renderer.getActiveMipmapLevel(),
      priorXR = renderer.xr.enabled, priorShadow = renderer.shadowMap.autoUpdate, priorScissorTest = renderer.getScissorTest(),
      priorTone = renderer.toneMapping,
      visibility = list.map(o => o.visible);
    renderer.getViewport(viewport); renderer.getScissor(scissor); busy = true;
    try {
      list.forEach(o => o.visible = false); renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;
      renderer.toneMapping = THREE.NoToneMapping; // Reflect linear radiance; water applies final tone mapping once.
      renderer.setRenderTarget(target); renderer.setScissorTest(false); renderer.clear();
      const draw = () => renderer.render(scene, camera);
      if (metrics) metrics.measure('reflection', draw); else draw();
    } finally {
      list.forEach((o, i) => o.visible = visibility[i]); renderer.xr.enabled = priorXR; renderer.shadowMap.autoUpdate = priorShadow;
      renderer.toneMapping = priorTone;
      renderer.setRenderTarget(priorTarget, priorFace, priorMip); renderer.setViewport(viewport); renderer.setScissor(scissor);
      renderer.setScissorTest(priorScissorTest); busy = false;
    }
    return {texture: target.texture, matrix, surface: active.name, level: active.level, width: target.width, height: target.height};
  }
  function dispose() {if (disposed) return; disposed = true; target?.dispose(); target = null; metrics?.untrackTarget('planar-reflection');}
  return {capture, dispose};
}
