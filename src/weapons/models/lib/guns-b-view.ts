/**
 * Model-viewer wrapper for the guns-b rifles. URL parameters:
 *   markers=0        hide the anchor markers (shown by default)
 *   bolt=0..1        slide the bolt back by that fraction of cycleTravel
 *   lift=0..1        roll the bolt about its axis, up to 60 degrees
 *   mag=0..1         move the magazine or clip out, up to 16 cm along its parent's -Y
 *   trigger=0..1     squeeze the trigger
 *   align=sight      put the sight anchor at the world origin, so
 *                    `cam=0,0,0&look=0,0,-1&fov=50` is the aimed view
 * Markers: muzzle red, ejection orange, sight cyan, trigger grip green,
 * support grip magenta. Ejection and grips also show their axes
 * (X red, Y green, Z blue; each bar is 4 cm).
 */
import * as THREE from 'three/webgpu';
import type { Viewable } from '../../../dev/viewer';
import type { GunModule } from '../api';

const AXIS_LENGTH = 0.04;
const AXIS_COLORS = [0xff3030, 0x30ff30, 0x4060ff] as const;
const TRIGGER_PULL = 0.3;
/** Same motions the weapon view model applies (src/weapons/view/parts.ts). */
const BOLT_LIFT = 1.05;
const MAGAZINE_OUT = 0.16;

function dot(color: number, radius = 0.004): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicNodeMaterial({ color }));
}

function axes(): THREE.Group {
  const group = new THREE.Group();
  AXIS_COLORS.forEach((color, axis) => {
    const size: [number, number, number] = [0.0015, 0.0015, 0.0015];
    size[axis] = AXIS_LENGTH;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicNodeMaterial({ color }));
    bar.position.setComponent(axis, AXIS_LENGTH / 2);
    group.add(bar);
  });
  return group;
}

export function gunViewable(module: GunModule): Viewable {
  return {
    assets: module.assets,
    create(assets) {
      const params = new URLSearchParams(location.search);
      const fraction = (name: string): number => Math.min(1, Math.max(0, Number(params.get(name) ?? 0)));
      const model = module.build(assets);
      const { bolt, magazine, trigger } = model.parts;
      if (bolt) {
        bolt.position.z += fraction('bolt') * model.cycleTravel;
        bolt.rotation.z += fraction('lift') * BOLT_LIFT;
      }
      if (magazine) magazine.position.y -= fraction('mag') * MAGAZINE_OUT;
      if (trigger) trigger.rotation.x += fraction('trigger') * TRIGGER_PULL;

      if (params.get('markers') !== '0') {
        model.muzzle.add(dot(0xff2020));
        model.ejection.add(dot(0xff9020), axes());
        model.sight.add(dot(0x20e0ff));
        model.grips.trigger.add(dot(0x20ff40), axes());
        model.grips.support.add(dot(0xff30ff), axes());
      }
      if (params.get('align') === 'sight') model.root.position.copy(model.sight.position).negate();
      return model.root;
    },
  };
}
