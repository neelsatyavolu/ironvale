/**
 * Model-viewer page for the first-person arms, holding one of the guns-c guns.
 * The scene is laid out as the game sees it: camera at the origin looking down
 * -Z, gun at a hip pose. Shoot the first-person view with
 * `cam=0,0,0&look=0,0,-1&fov=78`, or orbit it from outside.
 *
 * URL parameters on top of the viewer's own:
 * - `gun=m4a1|m249` picks the gun (default m4a1).
 * - `hip=x,y,z` moves the hip pose (default 0.2,-0.2,-0.45).
 * - `aim=1` puts the gun's sight anchor at the origin instead.
 * - `support=0` passes a null support grip, which tucks the off hand away.
 * - `markers=1` shows the gun's anchor markers.
 * - `sway=1` rocks the gun so the arms can be watched following it.
 * - `clay=1` swaps every material for a pale matte one (arms warm, gun cool), to read shapes and contact.
 * - `trigger=x,y,z` or `supportAt=x,y,z` moves that grip anchor (gun space), to try a hold before changing the layout.
 */
import * as THREE from 'three/webgpu';
import type { Viewable } from '../../dev/viewer';
import type { ArmsRig, GunModel } from '../../game/contracts';
import { ARMS_ASSETS, buildArms } from './arms';
import { addMarkers } from './lib/guns-c-view';
import m249 from './m249.gun';
import m4a1 from './m4a1.gun';

const GUNS = { m4a1, m249 } as const;
const params = new URLSearchParams(location.search);
const gunId = params.get('gun') ?? 'm4a1';
const module = gunId in GUNS ? GUNS[gunId as keyof typeof GUNS] : null;

let arms: ArmsRig | null = null;
let gun: GunModel | null = null;
const hip = new THREE.Vector3(0.2, -0.2, -0.45);
const hipParts = params.get('hip')?.split(',').map(Number);
if (hipParts?.length === 3 && hipParts.every(Number.isFinite)) hip.fromArray(hipParts);

function clay(object: THREE.Object3D, color: number): void {
  const material = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.8 });
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) child.material = material;
  });
}

const sway = new THREE.Vector3();

const viewable: Viewable = {
  assets: [...ARMS_ASSETS, ...(module?.assets ?? [])],
  create(assets) {
    const view = new THREE.Group();
    arms = buildArms(assets);
    view.add(arms.root);
    if (module) {
      gun = module.build(assets);
      if (params.get('markers') === '1') addMarkers(gun);
      for (const [name, grip] of [['trigger', gun.grips.trigger], ['supportAt', gun.grips.support]] as const) {
        const moved = params.get(name)?.split(',').map(Number);
        if (moved?.length === 3 && moved.every(Number.isFinite)) grip.position.fromArray(moved);
      }
      view.add(gun.root);
      if (params.get('aim') === '1') {
        gun.root.updateMatrixWorld(true);
        gun.root.matrix.copy(gun.sight.matrixWorld).invert();
        gun.root.matrix.decompose(gun.root.position, gun.root.quaternion, gun.root.scale);
      } else {
        gun.root.position.copy(hip);
      }
      if (params.get('clay') === '1') clay(gun.root, 0x6f86a8);
    }
    if (params.get('clay') === '1') clay(arms.root, 0xd8b8a0);
    return view;
  },
  update(_object, _dt, elapsed) {
    if (!arms || !gun) return;
    if (params.get('sway') === '1') {
      gun.root.rotation.set(Math.sin(elapsed * 2.1) * 0.08, Math.sin(elapsed * 1.3) * 0.12, Math.sin(elapsed * 1.7) * 0.06);
      gun.root.position.copy(hip).add(sway.set(0, Math.sin(elapsed * 2.6) * 0.02, Math.sin(elapsed * 1.9) * 0.05));
    }
    arms.update(gun.grips.trigger, params.get('support') === '0' ? null : gun.grips.support);
  },
};

export default viewable;
