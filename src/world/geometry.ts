import * as THREE from 'three/webgpu';

/**
 * Box whose UVs are scaled by each face's real size, so a tiling texture keeps
 * the same texel density on boxes of any dimensions. `tile` is the size in
 * metres that one texture repeat covers.
 */
export function tiledBox(width: number, height: number, depth: number, tile = 2): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const uv = geometry.getAttribute('uv');
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z; four vertices each.
  const faceSizes: readonly (readonly [number, number])[] = [
    [depth, height],
    [depth, height],
    [width, depth],
    [width, depth],
    [width, height],
    [width, height],
  ];
  faceSizes.forEach(([u, v], face) => {
    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      uv.setXY(index, (uv.getX(index) * u) / tile, (uv.getY(index) * v) / tile);
    }
  });
  uv.needsUpdate = true;
  return geometry;
}

/** Horizontal plane (facing +Y) with world-scaled UVs. */
export function tiledGround(width: number, depth: number, tile = 2, segments = 1): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) * width) / tile, (uv.getY(i) * depth) / tile);
  }
  uv.needsUpdate = true;
  return geometry;
}

/** Mark every mesh under `root` as a shadow caster and receiver. */
export function enableShadows(root: THREE.Object3D, cast = true, receive = true): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = cast;
      child.receiveShadow = receive;
    }
  });
}
