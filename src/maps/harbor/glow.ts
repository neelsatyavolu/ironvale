import * as THREE from 'three/webgpu';
import { float, positionWorld, smoothstep, texture, uv, vec3 } from 'three/tsl';
import type { Kit } from './facade';
import { ALLEY, RAMP, TERRACE_EDGE, TERRACE_Y } from './layout';

const POOL_RADIUS = 4.4;
const WASH_RADIUS = 1.9;

/**
 * Pools of lamplight on the paving under every lantern and a wash up the wall
 * behind the bracketed ones. Only eight lanterns carry a real light, so these
 * painted pools are what makes the rest look lit. One instanced quad, drawn
 * additively: it brightens whatever is under it and costs no lighting.
 */
export function addGlow(kit: Kit, root: THREE.Object3D): { dispose(): void } {
  const transforms: THREE.Matrix4[] = [];
  const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  for (const [x, y, z, nx, nz] of kit.lanterns) {
    const onSlope = z > TERRACE_EDGE && z < -4.5 && ((x > ALLEY.x0 - 0.5 && x < ALLEY.x1 + 0.5) || (x > RAMP.x0 - 0.5 && x < RAMP.x1 + 0.5));
    const ground = z < TERRACE_EDGE + 0.2 ? TERRACE_Y : 0;
    const drop = y - ground;
    if (!onSlope && drop > 1.5 && drop < 5) {
      const size = POOL_RADIUS * 2 * (drop / 3.5);
      transforms.push(new THREE.Matrix4().compose(new THREE.Vector3(x + nx * 0.5, ground + 0.035, z + nz * 0.5), flat, new THREE.Vector3(size, size, 1)));
    }
    if (nx !== 0 || nz !== 0) {
      const facing = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(nx, nz), 0));
      // Reach of the bracket is half a metre; the wash lies just off the plaster behind it.
      transforms.push(new THREE.Matrix4().compose(new THREE.Vector3(x - nx * 0.42, y - 0.25, z - nz * 0.42), facing, new THREE.Vector3(WASH_RADIUS * 2, WASH_RADIUS * 2.4, 1)));
    }
  }

  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const fromCentre = uv().sub(0.5).length().mul(2);
  const falloff = smoothstep(0.05, 1, fromCentre).oneMinus().pow(2.2);
  // Broken up by the same noise as the dirt, so the pool is not a perfect disc.
  const mottle = texture(kit.mats.grime, positionWorld.xz.add(positionWorld.y).div(3.7)).r.mul(0.5).add(0.75);
  material.colorNode = vec3(1.0, 0.56, 0.22).mul(falloff).mul(mottle).mul(float(0.42));
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, transforms.length));
  mesh.count = transforms.length;
  transforms.forEach((transform, i) => mesh.setMatrixAt(i, transform));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.name = 'harbor-glow';
  mesh.renderOrder = 2;
  root.add(mesh);
  return {
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
