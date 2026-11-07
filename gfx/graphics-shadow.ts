// Directional shadow map on the existing sky light. No game, renderer, or sky globals are owned here.
// Call update AFTER updateSky: the sky writes a direction vector to light.position each frame.
const MAP_SIZE = 2048, HALF_EXTENT = 48, SHADOW_DISTANCE = 100, SCAN_MS = 350;
type Previous = {cast: boolean; receive: boolean};

export function createGraphicsShadow(scene: any, renderer: any, player: any) {
  const light = scene.children.find((o: any) => o.isDirectionalLight);
  if (!light) throw new Error('그림자 광원을 찾을 수 없습니다.');
  const target = light.target, targetParent = target.parent, targetPosition = target.position.clone(),
    old = {enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type, cast: light.castShadow,
      width: light.shadow.mapSize.x, height: light.shadow.mapSize.y, bias: light.shadow.bias,
      normalBias: light.shadow.normalBias, radius: light.shadow.radius,
      camera: {left: light.shadow.camera.left, right: light.shadow.camera.right, top: light.shadow.camera.top,
        bottom: light.shadow.camera.bottom, near: light.shadow.camera.near, far: light.shadow.camera.far}},
    previous = new Map<any, Previous>(), center = new THREE.Vector3(), sun = new THREE.Vector3(), size = new THREE.Vector3();
  let enabled = false, disposed = false, lastScan = -Infinity;

  const lit = (m: any) => !!m && !m.transparent && (m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshStandardMaterial || m.isMeshPhysicalMaterial);
  function scan() {
    scene.updateMatrixWorld(true);
    const p = player.position, seen = new Set<any>();
    scene.traverse((obj: any) => {
      if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      if (!materials.some(lit)) return;
      seen.add(obj);
      if (!previous.has(obj)) previous.set(obj, {cast: obj.castShadow, receive: obj.receiveShadow});
      const geometry = obj.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const sphere = geometry.boundingSphere;
      if (!sphere || !geometry.boundingBox) return;
      center.copy(sphere.center).applyMatrix4(obj.matrixWorld);
      const radius = sphere.radius * Math.max(Math.abs(obj.scale.x), Math.abs(obj.scale.y), Math.abs(obj.scale.z));
      const bounds = geometry.boundingBox;
      size.subVectors(bounds.max, bounds.min);
      const near = Math.hypot(center.x - p.x, center.z - p.z) - radius < SHADOW_DISTANCE;
      // Large terrain sheets receive shadows; only bounded, elevated, opaque objects cast them.
      const terrain = obj.name?.startsWith('terrain-') || obj.userData?.terrainStep != null;
      obj.receiveShadow = true;
      obj.castShadow = !terrain && near && radius < 150 && size.y * Math.abs(obj.scale.y) > 0.7;
    });
    for (const [obj, prev] of previous) if (!seen.has(obj)) {
      obj.castShadow = prev.cast; obj.receiveShadow = prev.receive; previous.delete(obj);
    }
  }
  function setEnabled(on: boolean) {
    if (disposed || on === enabled) return;
    enabled = on;
    if (on) {
      if (!target.parent) scene.add(target);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      light.castShadow = true;
      light.shadow.mapSize.set(MAP_SIZE, MAP_SIZE);
      light.shadow.bias = -0.0003;
      light.shadow.normalBias = 0.06;
      light.shadow.radius = 2;
      Object.assign(light.shadow.camera, {left: -HALF_EXTENT, right: HALF_EXTENT, top: HALF_EXTENT,
        bottom: -HALF_EXTENT, near: 0.5, far: 350});
      light.shadow.camera.updateProjectionMatrix();
      lastScan = -Infinity;
    } else {
      renderer.shadowMap.enabled = old.enabled; renderer.shadowMap.type = old.type;
      light.castShadow = old.cast; light.shadow.bias = old.bias; light.shadow.normalBias = old.normalBias;
      light.shadow.radius = old.radius; light.shadow.mapSize.set(old.width, old.height);
      Object.assign(light.shadow.camera, old.camera); light.shadow.camera.updateProjectionMatrix();
      if (light.shadow.map) {light.shadow.map.dispose(); light.shadow.map = null;}
      light.position.sub(target.position).normalize().multiplyScalar(100);
      target.position.copy(targetPosition);
      if (!targetParent && target.parent === scene) scene.remove(target);
      for (const [obj, prev] of previous) {obj.castShadow = prev.cast; obj.receiveShadow = prev.receive;}
      previous.clear();
    }
  }
  function update(now = performance.now()) {
    if (!enabled || disposed) return;
    // Texel alignment keeps shadows steady while the player walks.
    const p = player.position, texel = HALF_EXTENT * 2 / MAP_SIZE,
      x = Math.round(p.x / texel) * texel, z = Math.round(p.z / texel) * texel;
    sun.copy(light.position).normalize();
    if (sun.lengthSq() < 0.01) sun.set(0.4, 0.8, 0.3).normalize();
    target.position.set(x, p.y, z);
    light.position.copy(target.position).addScaledVector(sun, 150);
    target.updateMatrixWorld();
    if (now - lastScan >= SCAN_MS) {scan(); lastScan = now;}
  }
  function dispose() {if (!disposed) {setEnabled(false); disposed = true;}}
  function state() {return {enabled, mapSize: MAP_SIZE, halfExtent: HALF_EXTENT,
    tracked: previous.size, casters: [...previous.keys()].filter(o => o.castShadow).length};}
  return {setEnabled, update, state, dispose};
}
