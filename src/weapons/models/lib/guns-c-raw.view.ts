/**
 * Developer aid: shows any GLB by URL so a source model can be judged before
 * it is processed. `/?view=weapons/models/lib/guns-c-raw&glb=/.cache/guns-c/x.glb&scale=1`.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Viewable } from '../../../dev/viewer';

const viewable: Viewable = {
  async create() {
    const params = new URLSearchParams(location.search);
    const url = params.get('glb');
    if (!url) throw new Error('Pass &glb=<url>');
    const gltf = await new GLTFLoader().loadAsync(url);
    const group = new THREE.Group();
    group.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = Number(params.get('scale') ?? 1 / Math.max(size.x, size.y, size.z));
    gltf.scene.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-1);
    group.scale.setScalar(scale);
    group.rotation.y = Number(params.get('ry') ?? 0) * (Math.PI / 180);
    return group;
  },
};

export default viewable;
