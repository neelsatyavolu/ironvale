/**
 * Dresses the processed M24 mesh: swaps in the extended finishes and adds the
 * code-built scope and fittings as one mesh per finish. Geometry is built once
 * and shared by every copy of the gun.
 */
import * as THREE from 'three/webgpu';
import { furnitureParts, type FurnitureSpec } from './m24-furniture';
import { boltFinish, coatedLens, engraving, fastenerSteel, matteBlack, padFinish, steelFinish, stockFinish, wornBlack } from './m24-materials';
import { scopeParts, type ScopeSpec } from './m24-scope';
import { merge, type PartBins } from './m24-shapes';

export interface DetailSpec {
  readonly scope: ScopeSpec;
  readonly furniture: FurnitureSpec;
}

const FINISHES: Readonly<Record<string, (source: THREE.Material) => THREE.Material>> = {
  stock: stockFinish,
  rubber: padFinish,
  metal: steelFinish,
  bolt_steel: boltFinish,
};

const BIN_MATERIALS: { readonly [K in keyof PartBins]: () => THREE.Material } = {
  black: wornBlack,
  steel: fastenerSteel,
  marks: engraving,
  matte: matteBlack,
};

let built: { readonly key: string; readonly geometry: Readonly<Record<keyof PartBins, THREE.BufferGeometry>> } | null = null;

function geometries(spec: DetailSpec): Readonly<Record<keyof PartBins, THREE.BufferGeometry>> {
  const key = JSON.stringify(spec);
  if (built?.key === key) return built.geometry;
  const scope = scopeParts(spec.scope);
  const furniture = furnitureParts(spec.furniture);
  const bin = (name: keyof PartBins): THREE.BufferGeometry => merge([...scope[name], ...furniture[name]]);
  const geometry = { black: bin('black'), steel: bin('steel'), marks: bin('marks'), matte: bin('matte') };
  built = { key, geometry };
  return geometry;
}

/** Adds the scope and fittings to `mesh` and upgrades the finishes of the loaded parts. */
export function addDetails(mesh: THREE.Object3D, spec: DetailSpec): void {
  mesh.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || Array.isArray(node.material)) return;
    if (node.name === 'lens_ocular') node.material = coatedLens('lens_ocular', 0x05070a, 0.86, [240, 330], 0.3);
    else if (node.name === 'lens_objective') node.material = coatedLens('lens_objective', 0x0a0810, 0.55, [330, 520], 1);
    else node.material = FINISHES[node.material.name]?.(node.material) ?? node.material;
  });
  const geometry = geometries(spec);
  for (const name of Object.keys(BIN_MATERIALS) as (keyof PartBins)[]) {
    const part = new THREE.Mesh(geometry[name], BIN_MATERIALS[name]());
    part.name = `m24-${name}`;
    mesh.add(part);
  }
}
