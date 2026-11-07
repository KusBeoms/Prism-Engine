// Selective bloom for r128's global THREE build. Only the shared glow material emits.
// The regular scene remains on screen: the mask, separable blur, and additive overlay
// are independent of the main color/tone-mapping pipeline.
import {glowMat} from '../kit/merge.js';
import type {createGraphicsMetrics} from './graphics-metrics.js';

type Metrics = ReturnType<typeof createGraphicsMetrics>;
const VERTEX = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BLUR = `uniform sampler2D source; uniform vec2 direction; varying vec2 vUv;
void main() {
  vec4 c = texture2D(source, vUv) * 0.227027;
  c += texture2D(source, vUv + direction * 1.384615) * 0.316216;
  c += texture2D(source, vUv - direction * 1.384615) * 0.316216;
  c += texture2D(source, vUv + direction * 3.230769) * 0.070270;
  c += texture2D(source, vUv - direction * 3.230769) * 0.070270;
  gl_FragColor = c;
}`;
const COMPOSITE = `uniform sampler2D source; uniform float strength; varying vec2 vUv;
void main() {
  vec3 glow = texture2D(source, vUv).rgb * strength;
  gl_FragColor = vec4(glow, 1.0);
}`;

export function createGraphicsBloom(renderer: any, metrics?: Metrics) {
  const options = {minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, generateMipmaps: false};
  const mask = new THREE.WebGLRenderTarget(1, 1, {...options, depthBuffer: true}),
    blur = new THREE.WebGLRenderTarget(1, 1, {...options, depthBuffer: false});
  mask.texture.name = 'bloom-mask'; blur.texture.name = 'bloom-blur';
  mask.texture.generateMipmaps = blur.texture.generateMipmaps = false;
  // Black color must be written as well as depth: occluders can be drawn after glow.
  // three r128 은 한 재질을 instanceColor 있는/없는 InstancedMesh 에 섞어 쓰면 프로그램이 어긋나 렌더가 던진다 → 종류별 가림 재질
  const occluderInst = new THREE.MeshBasicMaterial({color: 0}), occluderInstColor = new THREE.MeshBasicMaterial({color: 0}),
    occluder = new THREE.MeshBasicMaterial({color: 0}),
    quadGeo = new THREE.PlaneBufferGeometry(2, 2),
    blurMat = new THREE.ShaderMaterial({vertexShader: VERTEX, fragmentShader: BLUR,
      uniforms: {source: {value: null}, direction: {value: new THREE.Vector2()}}, depthTest: false, depthWrite: false, toneMapped: false}),
    composite = new THREE.ShaderMaterial({vertexShader: VERTEX, fragmentShader: COMPOSITE,
      uniforms: {source: {value: null}, strength: {value: 0.8}}, transparent: true,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false}),
    screen = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    quad = new THREE.Mesh(quadGeo, blurMat);
  screen.add(quad);
  const dimensions = new THREE.Vector2();
  let width = 0, height = 0, busy = false, disposed = false;
  function resize() {
    if (disposed) return;
    renderer.getDrawingBufferSize(dimensions);
    const w = Math.max(1, Math.ceil(dimensions.x * 0.5)), h = Math.max(1, Math.ceil(dimensions.y * 0.5));
    if (w === width && h === height) return;
    width = w; height = h; mask.setSize(w, h); blur.setSize(w, h);
    metrics?.trackTarget('bloom-mask', {width: w, height: h, colorBytes: [4], depthBytes: 4});
    metrics?.trackTarget('bloom-blur', {width: w, height: h, colorBytes: [4]});
  }
  function render(scene: any, view: any) {
    if (disposed || busy || !scene || !view) return;
    resize(); busy = true;
    const saved: {object: any; material?: any; visible?: boolean}[] = [], luminous = glowMat(),
      target = renderer.getRenderTarget(), viewport = renderer.getViewport(new THREE.Vector4()),
      scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest(),
      clearColor = renderer.getClearColor(new THREE.Color()).clone(), clearAlpha = renderer.getClearAlpha(),
      background = scene.background, autoClear = renderer.autoClear,
      shadowEnabled = renderer.shadowMap.enabled, xrEnabled = renderer.xr.enabled;
    const occluderOf = (o: any) => (o.isInstancedMesh ? (o.instanceColor ? occluderInstColor : occluderInst) : occluder);
    try {
      const pass = () => {
        scene.background = null;
        scene.traverseVisible((o: any) => {
          if (!o.isMesh && !o.isSprite && !o.isPoints && !o.isLine) return;
          if (o.renderOrder < 0 || !o.isMesh) {saved.push({object: o, visible: o.visible}); o.visible = false; return;}
          const original = o.material;
          if (!original) return;
          if (Array.isArray(original)) {
            const changed = original.map(m => m === luminous ? m : occluderOf(o));
            saved.push({object: o, material: original}); o.material = changed;
          } else if (original !== luminous) {
            if (original.transparent && !original.depthWrite) {saved.push({object: o, visible: o.visible}); o.visible = false;}
            else {saved.push({object: o, material: original}); o.material = occluderOf(o);}
          }
        });
        renderer.shadowMap.enabled = false; renderer.xr.enabled = false; renderer.autoClear = false;
        renderer.setScissorTest(false); renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(mask); renderer.clear(true, true, true); renderer.render(scene, view);
        // Restore scene before drawing screen-space quads, even if later passes fail.
        for (const entry of saved) {if (entry.material !== undefined) entry.object.material = entry.material; if (entry.visible !== undefined) entry.object.visible = entry.visible;}
        saved.length = 0; scene.background = background;
        blurMat.uniforms.source.value = mask.texture; blurMat.uniforms.direction.value.set(1 / width, 0);
        quad.material = blurMat; renderer.setRenderTarget(blur); renderer.clear(true, false, false); renderer.render(screen, camera);
        blurMat.uniforms.source.value = blur.texture; blurMat.uniforms.direction.value.set(0, 1 / height);
        renderer.setRenderTarget(mask); renderer.clear(true, false, false); renderer.render(screen, camera);
        composite.uniforms.source.value = mask.texture; quad.material = composite;
        renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
        renderer.render(screen, camera);
      };
      if (metrics) metrics.measure('postprocess', pass); else pass();
    } finally {
      for (const entry of saved) {if (entry.material !== undefined) entry.object.material = entry.material; if (entry.visible !== undefined) entry.object.visible = entry.visible;}
      scene.background = background; renderer.setRenderTarget(target); renderer.setViewport(viewport);
      renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); renderer.setClearColor(clearColor, clearAlpha);
      renderer.autoClear = autoClear; renderer.shadowMap.enabled = shadowEnabled; renderer.xr.enabled = xrEnabled; busy = false;
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; mask.dispose(); blur.dispose(); occluder.dispose(); occluderInst.dispose(); occluderInstColor.dispose(); quadGeo.dispose(); blurMat.dispose(); composite.dispose();
    metrics?.untrackTarget('bloom-mask'); metrics?.untrackTarget('bloom-blur');
  }
  return {render, resize, dispose, state: () => ({width, height, active: busy, disposed})};
}
