/**
 * Model-viewer page shared by the m1911, mp5 and r870 guns.
 *
 * URL parameters on top of the viewer's own:
 * - `markers=0` hides the anchor markers (muzzle red, ejection yellow with a
 *   line along +X, sight cyan, sight line white, trigger hand green, support
 *   hand magenta; each hand shows its finger axis and a shorter thumb axis).
 * - `cycle=0..1` pulls the bolt, slide or pump back by that share of `cycleTravel`.
 * - `mag=0.08` drops the magazine by that many metres.
 * - `aim=1` moves the gun so its sight anchor sits at the world origin looking
 *   down -Z: shoot it with `cam=0,0,0&look=0,0,-1&fov=50` to check the sights.
 * - `arms=1` adds the first-person arms holding the gun, to judge the grip
 *   anchors. Without `aim=1` the gun then sits at a hip pose in front of a
 *   camera at the origin (`hip=x,y,z`, default 0.2,-0.2,-0.45): shoot it with
 *   `cam=0,0,0&look=0,0,-1&fov=78`.
 */
import * as THREE from 'three/webgpu';
import type { Viewable } from '../../../dev/viewer';
import type { ArmsRig, GunModel } from '../../../game/contracts';
import type { GunModule } from '../api';
import { ARMS_ASSETS, buildArms } from '../arms';

const DEFAULT_HIP = [0.2, -0.2, -0.45];

function dot(color: number, radius: number): THREE.Mesh {
  const material = new THREE.MeshBasicNodeMaterial({ color, depthTest: false, transparent: true });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material);
  mesh.renderOrder = 10;
  return mesh;
}

function line(color: number, to: THREE.Vector3): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]);
  const result = new THREE.Line(geometry, new THREE.LineBasicNodeMaterial({ color, depthTest: false, transparent: true }));
  result.renderOrder = 10;
  return result;
}

function addMarkers(gun: GunModel): void {
  gun.muzzle.add(dot(0xff3020, 0.004));
  gun.ejection.add(dot(0xffd000, 0.004), line(0xffd000, new THREE.Vector3(0.06, 0, 0)));
  gun.sight.add(dot(0x20e0ff, 0.004), line(0xffffff, new THREE.Vector3(0, 0, -1.6)));
  const hands: [THREE.Object3D, number][] = [
    [gun.grips.trigger, 0x30ff50],
    [gun.grips.support, 0xff40e0],
  ];
  for (const [grip, color] of hands) {
    grip.add(dot(color, 0.005), line(color, new THREE.Vector3(0, 0, -0.06)), line(0xffffff, new THREE.Vector3(0, 0.03, 0)));
  }
}

export function gunView(module: GunModule): Viewable {
  const params = new URLSearchParams(location.search);
  const withArms = params.get('arms') === '1';
  let arms: ArmsRig | null = null;
  let gun: GunModel | null = null;
  return {
    assets: [...(module.assets ?? []), ...(withArms ? ARMS_ASSETS : [])],
    create(assets) {
      gun = module.build(assets);
      const cycle = Number(params.get('cycle') ?? 0) * gun.cycleTravel;
      for (const part of [gun.parts.bolt, gun.parts.slide, gun.parts.pump]) {
        if (part) part.position.z = cycle;
      }
      if (gun.parts.magazine) gun.parts.magazine.position.y = -Number(params.get('mag') ?? 0);
      if (params.get('markers') !== '0') addMarkers(gun);

      const holder = new THREE.Group();
      holder.add(gun.root);
      if (params.get('aim') === '1') {
        gun.root.updateMatrixWorld(true);
        holder.applyMatrix4(gun.sight.matrixWorld.clone().invert());
      } else if (withArms) {
        const hip = params.get('hip')?.split(',').map(Number);
        holder.position.fromArray(hip?.length === 3 && hip.every(Number.isFinite) ? hip : DEFAULT_HIP);
      }
      if (!withArms) return holder;
      arms = buildArms(assets);
      const view = new THREE.Group();
      view.add(holder, arms.root);
      return view;
    },
    update() {
      if (arms && gun) arms.update(gun.grips.trigger, gun.grips.support);
    },
  };
}
