/**
 * Developer model viewer. Open `/?view=<path>` where <path> is a file under
 * src/ ending in `.view.ts`, without that suffix, for example
 * `/?view=weapons/models/m4a1`. The module default-exports a `Viewable`.
 *
 * Camera: `&yaw=35&pitch=15&dist=1.2&at=0,0.1,0` orbits a target, or
 * `&cam=x,y,z&look=x,y,z` places it exactly. `&bg=dark|sky` picks the backdrop.
 * `&t=1.5` freezes the viewable's clock at that time for repeatable shots.
 */
import * as THREE from 'three/webgpu';
import { Assets } from '../core/assets';
import { graphicsForTier } from '../core/settings';
import { flatMaterial } from '../render/materials';
import { Engine } from '../render/engine';

export interface Viewable {
  /** Asset ids to preload. */
  readonly assets?: readonly string[];
  create(assets: Assets): THREE.Object3D | Promise<THREE.Object3D>;
  /** Optional animation hook. */
  update?(object: THREE.Object3D, dt: number, elapsed: number): void;
}

const modules = import.meta.glob<{ default: Viewable }>('../**/*.view.ts');
const DEG = Math.PI / 180;

function vec(text: string | null, fallback: THREE.Vector3): THREE.Vector3 {
  const parts = text?.split(',').map(Number);
  if (!parts || parts.length !== 3 || !parts.every(Number.isFinite)) return fallback;
  return new THREE.Vector3(parts[0], parts[1], parts[2]);
}

export async function runViewer(canvas: HTMLCanvasElement, path: string): Promise<{ engine: Engine }> {
  const loader = modules[`../${path}.view.ts`];
  if (!loader) {
    const known = Object.keys(modules).map((key) => key.slice(3, -8));
    throw new Error(`No viewable "${path}". Available: ${known.join(', ') || 'none'}`);
  }
  const params = new URLSearchParams(location.search);
  const viewable = (await loader()).default;
  const graphics = { ...graphicsForTier('ultra'), dynamicResolution: false };
  const engine = await Engine.create(canvas, graphics);
  const assets = new Assets(graphics.textures, graphics.anisotropy);
  await assets.preload(['hdri-test', ...(viewable.assets ?? [])]);

  const sky = params.get('bg') === 'sky';
  engine.setLighting(
    {
      hdri: 'hdri-test',
      hdriRotation: 0,
      skyIntensity: 1,
      sunDirection: new THREE.Vector3(0.5, 0.8, 0.6).normalize(),
      sunColor: 0xfff1dd,
      sunIntensity: 3,
      fog: { color: 0x202020, density: 0 },
      exposure: 0.9,
      volumetric: 0,
      bloom: 0.6,
    },
    assets.hdri('hdri-test'),
  );
  if (!sky) engine.scene.background = new THREE.Color(0x1b1c1e);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), flatMaterial(0x3a3b3d, 0.85));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = Number(params.get('floor') ?? -1);
  floor.receiveShadow = true;
  engine.scene.add(floor);

  const object = await viewable.create(assets);
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  engine.scene.add(object);

  const target = vec(params.get('at'), new THREE.Vector3());
  const yaw = Number(params.get('yaw') ?? 35) * DEG;
  const pitch = Number(params.get('pitch') ?? 15) * DEG;
  const dist = Number(params.get('dist') ?? 1.2);
  const orbit = new THREE.Vector3(
    target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  engine.camera.position.copy(vec(params.get('cam'), orbit));
  engine.camera.lookAt(vec(params.get('look'), target));
  engine.setFov(Number(params.get('fov') ?? 40));

  const frozen = params.has('t') ? Number(params.get('t')) : null;
  if (frozen !== null) viewable.update?.(object, 0, frozen);
  engine.onFrame((dt, elapsed) => {
    if (frozen === null) viewable.update?.(object, dt, elapsed);
  });
  engine.start();
  return { engine };
}
