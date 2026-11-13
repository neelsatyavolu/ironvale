/**
 * Model-viewer page for the guns-c guns (M4A1, M249, M7, SCAR-H).
 *
 * URL parameters on top of the viewer's own:
 * - `markers=0` hides the anchor markers: muzzle red, ejection yellow with a
 *   line along +X, sight cyan with a white sight line, trigger hand green,
 *   support hand magenta (each hand: long line along the fingers, short line
 *   toward the thumb).
 * - `cycle=0..1` pulls the bolt back by that share of `cycleTravel`.
 * - `mag=0.1` drops the magazine or belt box by that many metres.
 * - `cover=60` opens the feed cover by that many degrees.
 * - `aim=1` moves the gun so its sight anchor sits at the origin looking down
 *   -Z: shoot it with `cam=0,0,0&look=0,0,-1&fov=50` to check the sight picture.
 */
import * as THREE from 'three/webgpu';
import type { Viewable } from '../../../dev/viewer';
import type { GunModel } from '../../../game/contracts';
import type { GunModule } from '../api';

function dot(color: number, radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 8),
    new THREE.MeshBasicNodeMaterial({ color, depthTest: false, transparent: true }),
  );
  mesh.renderOrder = 10;
  return mesh;
}

function line(color: number, to: THREE.Vector3): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]);
  const result = new THREE.Line(geometry, new THREE.LineBasicNodeMaterial({ color, depthTest: false, transparent: true }));
  result.renderOrder = 10;
  return result;
}

export function addMarkers(gun: GunModel): void {
  gun.muzzle.add(dot(0xff3020, 0.004));
  gun.ejection.add(dot(0xffd000, 0.004), line(0xffd000, new THREE.Vector3(0.06, 0, 0)));
  gun.sight.add(dot(0x20e0ff, 0.004), line(0xffffff, new THREE.Vector3(0, 0, -1.2)));
  for (const [grip, color] of [
    [gun.grips.trigger, 0x30ff50],
    [gun.grips.support, 0xff40e0],
  ] as const) {
    grip.add(dot(color, 0.005), line(color, new THREE.Vector3(0, 0, -0.07)), line(color, new THREE.Vector3(0, 0.035, 0)));
  }
}

/** Applies the `cycle`, `mag` and `cover` URL parameters to a built gun. */
export function poseParts(gun: GunModel, params: URLSearchParams): void {
  const cycle = Number(params.get('cycle') ?? 0);
  if (gun.parts.bolt) gun.parts.bolt.position.z = cycle * gun.cycleTravel;
  if (gun.parts.chargingHandle) gun.parts.chargingHandle.position.z = cycle * gun.cycleTravel;
  if (gun.parts.magazine) gun.parts.magazine.position.y = -Number(params.get('mag') ?? 0);
  if (gun.parts.cover) {
    // Opened the way the view model does it: a turn about the part's own +X on top of its rest pose.
    const open = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(Number(params.get('cover') ?? 0)));
    gun.parts.cover.quaternion.multiply(open);
  }
}

export function gunViewable(module: GunModule): Viewable {
  return {
    assets: module.assets,
    create(assets) {
      const params = new URLSearchParams(location.search);
      const gun = module.build(assets);
      if (params.get('markers') !== '0') addMarkers(gun);
      poseParts(gun, params);
      const holder = new THREE.Group();
      holder.add(gun.root);
      if (params.get('aim') === '1') {
        // Put the sight anchor at the holder's origin, looking down -Z.
        gun.root.updateMatrixWorld(true);
        holder.matrix.copy(gun.sight.matrixWorld).invert();
        holder.matrix.decompose(holder.position, holder.quaternion, holder.scale);
      }
      return holder;
    },
  };
}
