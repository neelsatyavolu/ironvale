import * as THREE from 'three/webgpu';
import { seededRandom } from '../../core/random';
import type { Viewable } from '../../dev/viewer';
import { createMaterials } from './materials';
import { SAPLING_SPEC, TREE_SPECS, crownGeometry, trunkGeometry } from './tree-geometry';

/**
 * Tree line-up for the model viewer: each species as the close-up tree and, to
 * its right, the version drawn in the distance.
 * `npm run shot -- --params "view=maps/pinewood/tree&bg=sky&cam=0,6,34&look=0,10,0"`
 */
const view: Viewable = {
  assets: ['pbr-pinewood-bark', 'pbr-pinewood-planks', 'pbr-pinewood-rock', 'pbr-pinewood-stone'],
  create(assets) {
    const random = seededRandom(7);
    const materials = createMaterials(assets, random);
    const root = new THREE.Group();
    const stand = (x: number, trunk: THREE.BufferGeometry, crown: THREE.BufferGeometry): void => {
      for (const [geometry, material] of [
        [trunk, materials.bark],
        [crown, materials.needles],
      ] as const) {
        const mesh = new THREE.InstancedMesh(geometry, material, 1);
        mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(x, -1, 0));
        mesh.frustumCulled = false;
        root.add(mesh);
      }
    };
    TREE_SPECS.forEach((spec, i) => {
      stand(-16 + i * 12, trunkGeometry(spec, 9, random), crownGeometry(spec, 1, random));
      stand(-10 + i * 12, trunkGeometry(spec, 5, null), crownGeometry(spec, 0.55, random));
    });
    stand(17, trunkGeometry(SAPLING_SPEC, 5, random), crownGeometry(SAPLING_SPEC, 1, random));
    // The frond texture on its own, 4 m tall, to judge the painting.
    const card = new THREE.InstancedMesh(new THREE.PlaneGeometry(4, 4), materials.needles, 1);
    card.setMatrixAt(0, new THREE.Matrix4().makeTranslation(24, 2, 0));
    card.frustumCulled = false;
    root.add(card);
    return root;
  },
};

export default view;
