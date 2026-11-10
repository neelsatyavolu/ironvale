/**
 * Detachable box magazine and the bottom-metal collar it locks into, for a
 * rifle whose source mesh has neither (the M24 slot). Built once from
 * bevelled extrusions with the shared finishes; every gun copy reuses the
 * geometry.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gunMaterials } from '../materials';
import type { Vec3 } from './guns-b-rig';

export interface MagazineSpec {
  /** Centre of the magazine's top face in mesh space; hidden inside the stock when seated. */
  readonly top: Vec3;
  /** Front to back, along the bore. */
  readonly length: number;
  readonly width: number;
  /** Top face to the bottom of the floor plate. */
  readonly height: number;
  /** Height of the underside of the stock at the well, in mesh space. */
  readonly stockBottom: number;
}

const BEVEL = 0.0012;
const FLOOR_PLATE = { thickness: 0.004, overhang: 0.0012 };
const COLLAR = { margin: 0.0035, drop: 0.0025, rise: 0.006 };
const RIB = { depth: 0.0007, height: 0.0035, inset: 0.008 };

/** A box with chamfered edges whose side profile (length by height) has rounded lower corners. */
function shell(length: number, height: number, width: number, corner: number): THREE.BufferGeometry {
  const half = length / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-half, 0);
  shape.lineTo(half, 0);
  shape.lineTo(half, -height + corner);
  shape.quadraticCurveTo(half, -height, half - corner, -height);
  shape.lineTo(-half + corner, -height);
  shape.quadraticCurveTo(-half, -height, -half, -height + corner);
  shape.closePath();
  const depth = width - 2 * BEVEL;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelOffset: -BEVEL,
    bevelSegments: 2,
    curveSegments: 6,
  });
  // Extruded along shape Z: centre it, then turn so the profile lies in the gun's Z-Y plane.
  geometry.translate(0, 0, -depth / 2);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

let cached: { readonly magazine: THREE.BufferGeometry; readonly collar: THREE.BufferGeometry; readonly key: string } | null = null;

function geometries(spec: MagazineSpec): { readonly magazine: THREE.BufferGeometry; readonly collar: THREE.BufferGeometry } {
  const key = JSON.stringify(spec);
  if (cached?.key === key) return cached;
  const bodyHeight = spec.height - FLOOR_PLATE.thickness;
  const body = shell(spec.length, bodyHeight, spec.width, 0.003);
  const plate = shell(spec.length + 2 * FLOOR_PLATE.overhang, FLOOR_PLATE.thickness, spec.width + 2 * FLOOR_PLATE.overhang, 0.0015);
  plate.translate(0, -bodyHeight, 0);
  // Two pressed stiffening ribs on each side, on the part that shows below the stock.
  const exposedTop = spec.stockBottom - COLLAR.drop - spec.top[1];
  const ribs = [-1, 1].flatMap((side) =>
    [0.3, 0.62].map((fraction) => {
      const rib = new THREE.BoxGeometry(2 * RIB.depth, RIB.height, spec.length - 2 * RIB.inset);
      rib.translate(side * (spec.width / 2), exposedTop + (-bodyHeight - exposedTop) * fraction, 0);
      return rib;
    }),
  );
  const magazine = mergeGeometries([body, plate, ...ribs].map((part) => (part.index ? part.toNonIndexed() : part)));
  const collar = shell(spec.length + 2 * COLLAR.margin, COLLAR.rise + COLLAR.drop, spec.width + 2 * COLLAR.margin, 0.002);
  if (!magazine) throw new Error('Could not merge the magazine geometry');
  cached = { magazine, collar, key };
  return cached;
}

/**
 * Adds a `magazine` node (origin at the top of the magazine, so moving it along
 * its parent's -Y pulls it out of the well) and a fixed `magwell` collar to `mesh`.
 */
export function addMagazine(mesh: THREE.Object3D, spec: MagazineSpec): THREE.Object3D {
  const { magazine: magazineGeometry, collar: collarGeometry } = geometries(spec);
  const magazine = new THREE.Object3D();
  magazine.name = 'magazine';
  magazine.position.set(...spec.top);
  const box = new THREE.Mesh(magazineGeometry, gunMaterials.parkerized());
  box.name = 'magazine-box';
  magazine.add(box);

  const collar = new THREE.Mesh(collarGeometry, gunMaterials.anodized());
  collar.name = 'magwell';
  collar.position.set(spec.top[0], spec.stockBottom + COLLAR.rise, spec.top[2]);
  mesh.add(magazine, collar);
  return magazine;
}
