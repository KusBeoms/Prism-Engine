// 엔진 그래픽 파이프라인: 그림자 → 평면 반사 → 본 장면 → 블룸을 한 프레임 순서로 묶는다.
// 게임 상태(G)를 읽지 않고 host 로 필요한 것만 받는다. 튜닝 값(시야·안개·노출)은 게임 어댑터가 정한다.
import {createGraphicsMetrics} from './graphics-metrics.js';
import {effects} from './graphics-effects.js';
import {Q} from './quality.js';
import {createGraphicsShadow} from './graphics-shadow.js';
import {createGraphicsBloom} from './graphics-bloom.js';
import {createPlanarReflection, type SurfaceFinder} from './graphics-reflection.js';

export interface PipelineHost {
  renderer: any;
  scene: any;
  /** 매 프레임 호출: 현재 활성 카메라 */
  camera(): any;
  /** 플레이어(그림자 중심·반사 기준) */
  player(): any;
  /** 실내면 반사를 끈다 */
  inside(): boolean;
  surfaceFinder: SurfaceFinder;
  /** 톤매핑 노출(팔레트가 표시용으로 작성되어 있어 낮게 쓴다) */
  exposure: number;
}

export function createGraphicsPipeline(host: PipelineHost) {
  const {renderer, scene} = host;
  const metrics = createGraphicsMetrics(renderer);
  let shadows: ReturnType<typeof createGraphicsShadow> | null = null,
    bloom: ReturnType<typeof createGraphicsBloom> | null = null,
    reflection: ReturnType<typeof createPlanarReflection> | null = null;

  /** 하늘이 태양 방향을 정한 직후 프레임당 1회 */
  function updateLighting(now: number) {
    if (!shadows) shadows = createGraphicsShadow(scene, renderer, host.player());
    const enabled = effects.shadows && Q.shadows;
    shadows.setEnabled(enabled);
    if (enabled) {
      shadows.update(now);
      metrics.trackTarget('shadow-map', {width: 2048, height: 2048, colorBytes: [4], depthBytes: 4});
    } else metrics.untrackTarget('shadow-map');
  }

  function render() {
    const camera = host.camera(), player = host.player();
    renderer.outputEncoding = effects.tone ? THREE.sRGBEncoding : THREE.LinearEncoding;
    renderer.toneMapping = effects.tone ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = host.exposure;
    metrics.beginFrame();
    const reflectEnabled = effects.reflection && Q.postprocessing && !host.inside();
    if (reflectEnabled && !reflection) reflection = createPlanarReflection(renderer, scene, metrics, host.surfaceFinder);
    if (!reflectEnabled && reflection) {reflection.dispose(); reflection = null;}
    const reflected = reflection?.capture(camera, player.pos) ?? null;
    const surfaces: any[] = [], sea = scene.getObjectByName('sea'), lakes = scene.getObjectByName('lakes');
    if (sea) surfaces.push(sea);
    lakes?.traverse((o: any) => {if (o.isMesh && o.name.startsWith('lake:')) surfaces.push(o);});
    for (const surface of surfaces) {
      const u = surface.material.uniforms;
      if (!u?.uReflectionStrength) continue;
      const selected = reflected?.surface === surface.name;
      u.uReflectionStrength.value = selected ? 0.5 : 0;
      if (selected) {u.uReflectionMap.value = reflected!.texture; u.uReflectionMatrix.value.copy(reflected!.matrix);}
      else u.uReflectionMap.value = null;
    }
    metrics.measure('scene', () => renderer.render(scene, camera));
    if (effects.bloom && Q.postprocessing) {
      if (!bloom) bloom = createGraphicsBloom(renderer, metrics);
      bloom.render(scene, camera);
    } else if (bloom) {bloom.dispose(); bloom = null;}
  }

  return {metrics, snapshot: () => metrics.snapshot(), updateLighting, render};
}
