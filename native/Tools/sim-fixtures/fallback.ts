/**
 * The stand-in guns of src/weapons/view/fallback.ts, built by the real builder and flattened for
 * IronvaleViewModel: one entry per box or cylinder with its matrix in gun space (column-major, the
 * moving parts at rest), the material's base colour, roughness and metalness, and the anchors.
 */
import { BoxGeometry, CylinderGeometry, Mesh, type MeshStandardMaterial, type Object3D } from 'three/webgpu';
import { WEAPON_IDS } from '../../../src/weapons/models/api';
import { buildFallbackGun } from '../../../src/weapons/view/fallback';

function position(object: Object3D): number[] {
  const e = object.matrixWorld.elements;
  return [e[12]!, e[13]!, e[14]!];
}

export function fallbackGuns(): Record<string, unknown> {
  return Object.fromEntries(
    WEAPON_IDS.map((id) => {
      const gun = buildFallbackGun(id);
      gun.root.updateMatrixWorld(true);
      const shapes: unknown[] = [];
      gun.root.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        const material = child.material as MeshStandardMaterial & { opacity: number };
        const common = {
          matrix: Array.from(child.matrixWorld.elements),
          color: material.color.getHex(),
          roughness: material.roughness,
          metalness: material.metalness,
          opacity: material.transparent ? material.opacity : 1,
          part: child.parent && child.parent !== gun.root ? child.parent.name.replace(/^part_/, '') : null,
        };
        const geometry = child.geometry;
        if (geometry instanceof BoxGeometry) {
          const p = geometry.parameters;
          shapes.push({ ...common, kind: 'box', size: [p.width, p.height, p.depth] });
        } else if (geometry instanceof CylinderGeometry) {
          const p = geometry.parameters;
          shapes.push({ ...common, kind: 'cylinder', radius: p.radiusTop, height: p.height, sides: p.radialSegments });
        } else {
          throw new Error(`${id}: unexpected fallback geometry ${geometry.type}`);
        }
      });
      return [
        id,
        {
          shapes,
          muzzle: position(gun.muzzle),
          ejection: position(gun.ejection),
          sight: position(gun.sight),
          cycleTravel: gun.cycleTravel,
        },
      ];
    }),
  );
}
