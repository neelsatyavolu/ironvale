import * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../game/contracts';
import { flatMaterial, pbrMaterial } from '../../render/materials';
import { enableShadows, tiledBox, tiledGround } from '../../world/geometry';
import type { MapInstance, SpawnPoint } from '../../world/types';
import type { MapModule } from '../registry';

/** Developer test range: flat wet concrete, cover blocks, a shed and material probes. */
function build(ctx: MapBuildContext): MapInstance {
  const root = new THREE.Group();
  const concrete = pbrMaterial(ctx.assets.pbr('pbr-test-concrete'), { wetness: 0.7 });
  const dryConcrete = pbrMaterial(ctx.assets.pbr('pbr-test-concrete'));

  const ground = new THREE.Mesh(tiledGround(120, 120, 3), concrete);
  root.add(ground);
  ctx.world.addColliderObject(ground, 'concrete');

  const addBox = (w: number, h: number, d: number, x: number, z: number, material: THREE.Material, yaw = 0) => {
    const mesh = new THREE.Mesh(tiledBox(w, h, d, 2.5), material);
    mesh.position.set(x, h / 2, z);
    mesh.rotation.y = yaw;
    root.add(mesh);
    ctx.world.addColliderObject(mesh, 'concrete');
    return mesh;
  };

  for (let i = 0; i < 14; i++) {
    const w = 1 + ctx.random() * 3;
    const h = 0.9 + ctx.random() * 2.4;
    const angle = ctx.random() * Math.PI * 2;
    const radius = 8 + ctx.random() * 30;
    addBox(w, h, 1 + ctx.random() * 2, Math.cos(angle) * radius, Math.sin(angle) * radius, dryConcrete, ctx.random() * Math.PI);
  }

  // Shed: three walls and a roof so interiors, shadows and light shafts can be checked.
  const metal = flatMaterial(0x6d7478, 0.45, 0.9);
  addBox(10, 4, 0.3, 0, -18, dryConcrete);
  addBox(0.3, 4, 8, -5, -14, dryConcrete);
  addBox(0.3, 4, 8, 5, -14, dryConcrete);
  const roof = new THREE.Mesh(tiledBox(10.6, 0.25, 8.6, 2.5), metal);
  roof.position.set(0, 4.12, -14);
  root.add(roof);
  ctx.world.addColliderObject(roof, 'metal');

  // Material probes: chrome, painted, rough.
  const probes: readonly [number, number, number][] = [
    [0xffffff, 0.05, 1],
    [0xb03a2e, 0.35, 0],
    [0x2f6f4f, 0.8, 0],
  ];
  probes.forEach(([color, rough, metalness], i) => {
    const probe = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 32), flatMaterial(color, rough, metalness));
    probe.position.set(-3 + i * 3, 0.6, -6);
    root.add(probe);
  });

  // Steps: 0.18 m risers, the tallest the capsule walks up without jumping.
  for (let i = 0; i < 8; i++) addBox(3, 0.18 * (i + 1), 0.4, 14, -4 - i * 0.4, dryConcrete);

  enableShadows(root);

  const spawn = (x: number, z: number, yaw: number): SpawnPoint => ({ position: new THREE.Vector3(x, 0.05, z), yaw });
  return {
    root,
    bounds: new THREE.Box3(new THREE.Vector3(-55, -1, -55), new THREE.Vector3(55, 30, 55)),
    playerSpawns: [spawn(0, 6, 0)],
    enemySpawns: [spawn(-30, -30, 0), spawn(30, -30, 0), spawn(-30, 30, Math.PI), spawn(30, 30, Math.PI), spawn(0, -40, 0)],
    lighting: {
      hdri: 'hdri-test',
      hdriRotation: 0,
      skyIntensity: 1,
      sunDirection: new THREE.Vector3(-0.55, 0.42, -0.72).normalize(),
      sunColor: 0xffe2c0,
      sunIntensity: 4.5,
      fog: { color: 0xaab4c0, density: 0.006 },
      exposure: 0.9,
      volumetric: 0.6,
      bloom: 1,
    },
    weather: 'clear',
    reverb: 'open-field',
    ambience: [],
    interiors: [
      { box: new THREE.Box3(new THREE.Vector3(-5, 0, -18), new THREE.Vector3(5, 4, -10)), reverb: 'interior' },
    ],
    dispose: () => {
      root.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
    },
  };
}

const range: MapModule = {
  meta: { id: 'range', name: 'Test Range', tagline: 'Developer test map', assets: ['hdri-test', 'pbr-test-concrete'] },
  build,
};

export default range;
