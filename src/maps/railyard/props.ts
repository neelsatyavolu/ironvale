import * as THREE from 'three/webgpu';
import { MeshBuilder } from './builder';
import { buildForklift } from './forklift';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { buildGenerator } from './plant';
import { addChamferBox, rod } from './shapes';
import { shelter } from './shelter';

const WALL_TILE = 2.71;
const GALVANISED = 0x9a9d9c;
/** Tint that takes the scanned barrier from sun-bleached to rain-soaked. */
const WET_CONCRETE = new THREE.Color(0.6, 0.6, 0.6);
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

export const PALLET = { width: 1.2, depth: 1.0, height: 0.145 } as const;

/** Timber pallet, 1.2 x 1.0 m, origin at the centre of its underside. */
export function palletGeometry(): THREE.BufferGeometry {
  const builder = new MeshBuilder();
  for (let i = 0; i < 7; i++) builder.box(PALLET.width, 0.022, 0.1, 0, 0.134, -0.45 + i * 0.15);
  for (const x of [-0.55, 0, 0.55]) builder.box(0.1, 0.09, PALLET.depth, x, 0.067, 0);
  for (const z of [-0.45, 0, 0.45]) builder.box(PALLET.width, 0.022, 0.1, 0, 0.011, z);
  return builder.build();
}

type ModelId = 'mdl-railyard-barrel' | 'mdl-railyard-barrel-rusty' | 'mdl-railyard-barrier' | 'mdl-railyard-propane';

/** Collider size for each scanned prop (width, height, depth). */
const MODEL_BOX: Readonly<Record<ModelId, readonly [number, number, number]>> = {
  'mdl-railyard-barrel': [0.54, 0.87, 0.54],
  'mdl-railyard-barrel-rusty': [0.6, 0.93, 0.6],
  'mdl-railyard-barrier': [1.57, 1.1, 0.46],
  'mdl-railyard-propane': [0.32, 0.55, 0.32],
};

/**
 * Yard furniture. Scanned props are queued and drawn as one InstancedMesh per
 * model when `flush` runs; everything else is baked into the level batches.
 */
export class Props {
  readonly pallet: THREE.BufferGeometry;
  private readonly queued = new Map<ModelId, THREE.Matrix4[]>();

  constructor(
    private readonly kit: Kit,
    private readonly m: Materials,
  ) {
    this.pallet = kit.own(palletGeometry());
  }

  /** Queue a scanned prop standing on `y`, with a box collider. */
  model(id: ModelId, x: number, z: number, yaw = 0, y = 0): void {
    const list = this.queued.get(id) ?? [];
    list.push(this.kit.transform(x, y, z, yaw));
    this.queued.set(id, list);
    const [w, h, d] = MODEL_BOX[id];
    this.kit.collide(w, h, d, x, y, z, id === 'mdl-railyard-barrier' ? 'concrete' : 'metal', yaw);
  }

  /** A loose group of barrels around a point. */
  barrels(x: number, z: number, count: number, rusty = false): void {
    const kit = this.kit;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + kit.range(-0.4, 0.4);
      const reach = count === 1 ? 0 : 0.36 + 0.14 * count + kit.range(-0.08, 0.08);
      const id = rusty || kit.random() < 0.55 ? 'mdl-railyard-barrel-rusty' : 'mdl-railyard-barrel';
      this.model(id, x + Math.cos(angle) * reach, z + Math.sin(angle) * reach, kit.range(0, Math.PI * 2));
    }
  }

  /** Jersey barriers end to end, starting at (x, z) and running along `yaw`. */
  barrierRun(x: number, z: number, count: number, yaw: number): void {
    for (let i = 0; i < count; i++) {
      const along = i * 1.6;
      this.model('mdl-railyard-barrier', x + Math.cos(yaw) * along, z - Math.sin(yaw) * along, yaw + this.kit.range(-0.03, 0.03));
    }
  }

  palletStack(x: number, z: number, count: number, yaw = 0): void {
    const { kit, m } = this;
    for (let i = 0; i < count; i++) {
      kit.add(m.wood, this.pallet, kit.transform(x + kit.range(-0.03, 0.03), i * PALLET.height, z + kit.range(-0.03, 0.03), yaw + kit.range(-0.05, 0.05)));
    }
    kit.collide(PALLET.width, count * PALLET.height, PALLET.depth, x, 0, z, 'wood', yaw);
  }

  /**
   * Cartons stacked in courses on a footprint, each box drawn separately with a
   * hairline gap so the load reads as boxes and not as one block.
   */
  cartons(x: number, y: number, z: number, yaw: number, width: number, height: number, depth: number, tint: number): void {
    const { kit, m } = this;
    const columns = Math.max(1, Math.round(width / 0.56));
    const rows = Math.max(1, Math.round(depth / 0.48));
    const courses = Math.max(1, Math.round(height / 0.36));
    const shade = new THREE.Color();
    for (let course = 0; course < courses; course++) {
      for (let column = 0; column < columns; column++) {
        for (let row = 0; row < rows; row++) {
          const lx = ((column + 0.5) / columns - 0.5) * width;
          const lz = ((row + 0.5) / rows - 0.5) * depth;
          shade.setHex(tint).multiplyScalar(kit.range(0.82, 1.08));
          kit.box(m.carton, width / columns - 0.012, height / courses - 0.008, depth / rows - 0.012,
            x + lx * Math.cos(yaw) + lz * Math.sin(yaw), y + (course * height) / courses, z - lx * Math.sin(yaw) + lz * Math.cos(yaw),
            { yaw, color: shade.getHex() });
        }
      }
    }
  }

  /** Pallet carrying cartons, a shrink-wrapped block or sacks. About chest high. */
  loadedPallet(x: number, z: number, yaw = 0, y = 0): void {
    const { kit, m } = this;
    const kind = kit.random();
    const height = kit.range(0.85, 1.2);
    kit.add(m.wood, this.pallet, kit.transform(x, y, z, yaw));
    const base = y + PALLET.height;
    if (kind < 0.3) {
      // Shrink-wrapped block with a banded cap sheet.
      kit.box(m.wrap, 1.12, height, 0.94, x, base, z, { yaw });
      kit.box(m.matte, 1.14, 0.03, 0.96, x, base + height, z, { yaw, color: 0x7d7361 });
      for (const lift of [0.3, 0.7]) kit.box(m.matte, 1.135, 0.03, 0.955, x, base + height * lift, z, { yaw, color: 0x2b2d2e });
    } else if (kind < 0.8) {
      this.cartons(x, base, z, yaw, 1.12, height, 0.94, kit.pick([0x8c7352, 0x7d6748, 0x94805e] as const));
    } else {
      for (let i = 0; i < 5; i++) {
        kit.box(m.matte, 1.08, 0.17, 0.9, x, base + i * 0.175, z, { yaw: yaw + (i % 2) * 0.12, color: i % 2 ? 0xa39a86 : 0x979080 });
      }
    }
    kit.collide(PALLET.width, PALLET.height + height, PALLET.depth, x, y, z, 'wood', yaw);
  }

  /** 1000 litre IBC tote: plastic tank in a tubular cage on a steel pallet. */
  ibc(x: number, z: number, yaw = 0, y = 0): void {
    const { kit, m } = this;
    const at = kit.transform(x, y, z, yaw);
    const builder = new MeshBuilder();
    for (const height of [0.16, 0.42, 0.68, 0.94, 1.14]) {
      for (const sz of [-1, 1]) builder.box(1.2, 0.025, 0.025, 0, height, sz * 0.5);
      for (const sx of [-1, 1]) builder.box(0.025, 0.025, 1.0, sx * 0.6, height, 0);
    }
    for (let i = 0; i <= 6; i++) {
      for (const sz of [-1, 1]) builder.box(0.025, 1.0, 0.025, -0.6 + i * 0.2, 0.65, sz * 0.5);
    }
    for (let i = 1; i < 5; i++) {
      for (const sx of [-1, 1]) builder.box(0.025, 1.0, 0.025, sx * 0.6, 0.65, -0.5 + i * 0.2);
    }
    builder.box(1.2, 0.03, 1.0, 0, 0.135, 0);
    for (const sz of [-0.2, 0.2]) builder.box(1.2, 0.025, 0.025, 0, 1.14, sz);
    for (const sx of [-0.5, 0, 0.5]) builder.box(0.1, 0.12, 1.0, sx, 0.06, 0);
    const cage = builder.build();
    kit.add(m.rawSteel, cage, at, GALVANISED);
    cage.dispose();
    kit.box(m.matte, 1.12, 0.96, 0.92, x, y + 0.16, z, { yaw, color: 0x959d9f });
    // Fill level showing through the translucent tank.
    kit.box(m.matte, 1.125, 0.5, 0.925, x, y + 0.165, z, { yaw, color: 0x5f6a6f });
    kit.box(m.matte, 0.3, 0.2, 0.01, x + Math.sin(yaw) * 0.47, y + 0.7, z + Math.cos(yaw) * 0.47, { yaw, color: 0xe9e9e4 });
    const cap = new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12);
    kit.add(m.matte, cap, kit.transform(x, y + 1.145, z, yaw), 0x7a1f1a);
    cap.dispose();
    kit.collide(1.22, 1.17, 1.02, x, y, z, 'metal', yaw);
  }

  /**
   * Timber cable drum. `upright` stands it on its rims (tall cover, axis along
   * local X); otherwise it lies on one flange like a table.
   */
  spool(x: number, z: number, radius: number, upright: boolean, yaw = 0): void {
    const { kit, m } = this;
    const width = radius * 1.1;
    const builder = new MeshBuilder();
    const wood = new MeshBuilder();
    const flange = new THREE.CylinderGeometry(radius, radius, 0.07, 22);
    const drum = new THREE.CylinderGeometry(radius * 0.42, radius * 0.42, width, 14);
    const cable = new THREE.CylinderGeometry(radius * 0.74, radius * 0.74, width - 0.16, 18);
    for (const s of [-1, 1]) wood.add(flange, new THREE.Matrix4().makeTranslation(0, (s * (width - 0.07)) / 2, 0));
    wood.add(drum, new THREE.Matrix4());
    builder.add(cable, new THREE.Matrix4());
    for (const geometry of [flange, drum, cable]) geometry.dispose();
    // Built with the axis on Y; tip it over for a drum standing on its rims.
    const pose = upright
      ? kit.transform(x, radius, z, yaw).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
      : kit.transform(x, width / 2, z, yaw);
    const woodGeometry = wood.build();
    const cableGeometry = builder.build();
    kit.add(m.wood, woodGeometry, pose, 0xc9b89a);
    kit.add(m.matte, cableGeometry, pose, 0x17181a);
    woodGeometry.dispose();
    cableGeometry.dispose();
    if (upright) kit.collide(width, radius * 2, radius * 1.7, x, 0, z, 'wood', yaw);
    else kit.collide(radius * 1.8, width, radius * 1.8, x, 0, z, 'wood', yaw);
  }

  /** Interlocking concrete blocks, 1.6 x 0.8 x 0.8 m, stacked `levels` high in a row of `count`. */
  blocks(x: number, z: number, count: number, levels: number, yaw = 0): void {
    const { kit, m } = this;
    for (let i = 0; i < count; i++) {
      const cx = x + Math.cos(yaw) * i * 1.62;
      const cz = z - Math.sin(yaw) * i * 1.62;
      const tall = levels - (i === count - 1 && levels > 1 ? 1 : 0);
      for (let level = 0; level < tall; level++) {
        kit.box(m.wall, 1.6, 0.8, 0.8, cx, level * 0.8, cz, { yaw, tile: WALL_TILE, color: 0xc9c6bc });
      }
      for (const s of [-0.4, 0.4]) {
        kit.box(m.wall, 0.4, 0.08, 0.4, cx + Math.cos(yaw) * s, tall * 0.8, cz - Math.sin(yaw) * s, { yaw, tile: WALL_TILE, color: 0xc9c6bc });
      }
      kit.collide(1.6, tall * 0.8, 0.8, cx, 0, cz, 'concrete', yaw);
    }
  }

  /** Open steel waste skip, part full of rubble, boards and sacks. */
  skip(x: number, z: number, yaw: number, color: number): void {
    const { kit, m } = this;
    const at = kit.transform(x, 0, z, yaw);
    const builder = new MeshBuilder();
    builder.box(3.3, 0.08, 1.7, 0, 0.14, 0);
    for (const s of [-1, 1]) {
      builder.box(3.4, 1.1, 0.06, 0, 0.7, s * 0.85);
      builder.box(0.06, 1.1, 1.7, s * 1.7, 0.7, 0, 0xffffff, [0, 0, s * 0.16]);
      // Rolled top rail, pressed side ribs, skids, and the lugs the lorry's chains hook.
      addChamferBox(builder, [3.56, 0.1, 0.12], [0, 1.27, s * 0.87], 0xffffff, 0.03);
      addChamferBox(builder, [0.12, 0.1, 1.86], [s * 1.79, 1.27, 0], 0xffffff, 0.03);
      for (const rib of [-1.1, 0, 1.1]) addChamferBox(builder, [0.1, 1.02, 0.06], [rib, 0.7, s * 0.9], 0xffffff, 0.02);
      builder.box(0.18, 0.1, 1.5, s * 1.2, 0.05, 0);
      for (const lug of [-1.25, 1.25]) rod(builder, [lug, 0.95, s * 0.88], [lug, 0.95, s * 0.99], 0.04, 0xdddddd, 8);
    }
    const body = builder.build();
    kit.add(m.steel, body, at, color);
    body.dispose();

    // Load: a heap of rubble with odds and ends lying on it.
    const heap = new THREE.PlaneGeometry(3.2, 1.6, 44, 24).rotateX(-Math.PI / 2);
    const position = heap.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const px = position.getX(i);
      const pz = position.getZ(i);
      const lump = Math.sin(px * 3.7 + x) * Math.cos(pz * 5.1 + z) * 0.09 + Math.sin(px * 9.3 + pz * 7.7) * 0.035;
      // Broken brick and concrete: sharp-edged chunks a hand or two across.
      const chunk = Math.abs(Math.sin(px * 23.1 + pz * 5.3 + x) * Math.sin(pz * 27.7 - px * 7.9 + z)) ** 0.6 * 0.07;
      position.setY(i, 0.6 + lump + chunk + (1 - (px / 1.7) ** 2) * 0.16);
    }
    heap.computeVertexNormals();
    kit.add(m.wall, heap, at, 0x6a655c);
    heap.dispose();
    const junk = new MeshBuilder();
    const timber = new MeshBuilder();
    addChamferBox(junk, [0.58, 0.16, 0.36], [-0.8, 0.86, 0.2], 0x4c4a42, 0.07, [0.06, 0.5, 0.1]);
    addChamferBox(junk, [0.52, 0.15, 0.34], [-0.3, 0.88, -0.3], 0x56534a, 0.07, [-0.06, -0.3, 0.05]);
    junk.box(0.7, 0.012, 0.5, 0.9, 0.8, -0.2, 0x6b5539, [0.2, 0.9, 0.1]);
    rod(junk, [0.2, 0.74, 0.5], [1.3, 1.0, 0.1], 0.03, 0x5a5d5e, 6);
    timber.box(0.1, 0.03, 1.9, 0.4, 0.92, 0.1, 0x8d7f6c, [0.18, 1.2, 0]);
    timber.box(0.1, 0.03, 1.5, -1.0, 0.9, -0.1, 0x8d7f6c, [-0.22, 0.4, 0]);
    timber.box(0.1, 0.03, 1.3, 1.1, 0.95, 0.3, 0x8d7f6c, [0.35, -0.5, 0]);
    const junkGeometry = junk.build();
    const timberGeometry = timber.build();
    kit.add(m.matte, junkGeometry, at);
    kit.add(m.wood, timberGeometry, at);
    junkGeometry.dispose();
    timberGeometry.dispose();
    kit.collide(3.6, 1.3, 1.8, x, 0, z, 'metal', yaw);
  }

  /** Timber shipping crate with corner battens and skids. `y` is the underside. */
  crate(x: number, z: number, width: number, height: number, depth: number, yaw = 0, y = 0): void {
    const { kit, m } = this;
    const builder = new MeshBuilder();
    const batten = 0.09;
    builder.box(width, height, depth, 0, 0.1 + height / 2, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        builder.box(batten, height + 0.02, 0.03, sx * (width / 2 - batten / 2), 0.1 + height / 2, sz * (depth / 2 + 0.012), 0xd9cdb8);
        builder.box(0.03, height + 0.02, batten, sx * (width / 2 + 0.012), 0.1 + height / 2, sz * (depth / 2 - batten / 2), 0xd9cdb8);
      }
      for (const level of [batten / 2, height - batten / 2]) {
        builder.box(0.03, batten, depth, sx * (width / 2 + 0.012), 0.1 + level, 0, 0xd9cdb8);
        builder.box(width, batten, 0.03, 0, 0.1 + level, sx * (depth / 2 + 0.012), 0xd9cdb8);
      }
      // Diagonal brace on each long face.
      const reach = Math.hypot(width - batten * 2, height - batten * 2);
      builder.box(reach, batten * 0.8, 0.028, 0, 0.1 + height / 2, sx * (depth / 2 + 0.01), 0xd9cdb8, [0, 0, sx * Math.atan2(height - batten * 2, width - batten * 2)]);
      builder.box(0.1, 0.1, depth, sx * (width / 2 - 0.2), 0.05, 0, 0xa89a84);
    }
    builder.box(width + 0.02, 0.03, depth + 0.02, 0, 0.1 + height + 0.015, 0, 0xd9cdb8);
    const geometry = builder.build();
    kit.add(m.wood, geometry, kit.transform(x, y, z, yaw));
    geometry.dispose();
    kit.collide(width + 0.04, height + 0.13, depth + 0.04, x, y, z, 'wood', yaw);
  }

  /** Skid-mounted diesel generator. */
  generator(x: number, z: number, yaw: number): void {
    buildGenerator(this.kit, this.m, x, z, yaw);
  }

  /** Counterbalance forklift truck, parked. Forks point along local -Z. */
  forklift(x: number, z: number, yaw: number): void {
    buildForklift(this.kit, this.m, x, z, yaw);
  }

  /** Steel workbench with a timber top. */
  bench(x: number, z: number, yaw: number): void {
    const { kit, m } = this;
    kit.box(m.wood, 2.0, 0.05, 0.75, x, 0.87, z, { yaw, color: 0xb8a078 });
    kit.box(m.steel, 1.9, 0.82, 0.68, x, 0.05, z, { yaw, color: 0x35546b });
    kit.box(m.steel, 0.36, 0.26, 0.24, x + Math.cos(yaw) * 0.6, 0.92, z - Math.sin(yaw) * 0.6, { yaw, color: 0xa3261d });
    kit.collide(2.0, 0.92, 0.75, x, 0, z, 'wood', yaw);
  }

  /** Low rack of gas cylinders, like the ones chained up beside workshop doors. */
  cylinders(x: number, z: number, count: number, yaw: number): void {
    const { kit, m } = this;
    const body = new THREE.CylinderGeometry(0.115, 0.115, 1.3, 12);
    const neck = new THREE.SphereGeometry(0.115, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const colors = [0x6d2420, 0x24282b, 0x2b4e6b] as const;
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * 0.27;
      const cx = x + Math.cos(yaw) * offset;
      const cz = z - Math.sin(yaw) * offset;
      const tint = colors[i % colors.length] as number;
      kit.add(m.steel, body, new THREE.Matrix4().makeTranslation(cx, 0.65, cz), tint);
      kit.add(m.steel, neck, new THREE.Matrix4().makeTranslation(cx, 1.3, cz), tint);
      kit.post(m.rawSteel, 0.035, 0.14, cx, 1.39, cz, 0x8a8d8e, 8);
    }
    body.dispose();
    neck.dispose();
    const width = count * 0.27 + 0.1;
    kit.box(m.steel, width, 0.04, 0.04, x - Math.sin(yaw) * 0.14, 0.95, z - Math.cos(yaw) * 0.14, { yaw, color: 0x8a8d8e });
    kit.box(m.steel, width, 0.05, 0.36, x, 0, z, { yaw, color: 0x2a2c2e });
    for (const s of [-1, 1]) {
      kit.beam(m.steel, V(x + Math.cos(yaw) * s * (width / 2), 0, z - Math.sin(yaw) * s * (width / 2)), V(x + Math.cos(yaw) * s * (width / 2), 1.0, z - Math.sin(yaw) * s * (width / 2)), 0.04, 0.04, 0x2a2c2e);
    }
    kit.collide(width, 1.45, 0.36, x, 0, z, 'metal', yaw);
  }

  /** Create the instanced meshes for every queued scanned prop. */
  flush(): void {
    for (const [id, matrices] of this.queued) {
      const scene = this.kit.ctx.assets.gltf(id).scene;
      scene.updateMatrixWorld(true);
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const source = child.material as THREE.MeshStandardMaterial;
        // Rebuilt as a node material so it can take the sky visibility; a little glossier than the dry scans.
        const material = this.kit.own(
          new THREE.MeshStandardNodeMaterial({
            map: source.map,
            normalMap: source.normalMap,
            roughnessMap: source.roughnessMap,
            metalnessMap: source.metalnessMap,
            aoMap: source.aoMap,
            color: id === 'mdl-railyard-barrier' ? WET_CONCRETE : source.color,
            metalness: source.metalness,
            roughness: 0.78,
          }),
        );
        shelter(material, this.m.visibility);
        const placed = matrices.map((matrix) => matrix.clone().multiply(child.matrixWorld));
        this.kit.instances(child.geometry as THREE.BufferGeometry, material, placed);
      });
    }
    this.queued.clear();
  }
}
