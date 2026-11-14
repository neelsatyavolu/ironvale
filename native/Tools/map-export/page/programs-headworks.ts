// Headworks surface programs (PLAN.md 3.4, M9): reference materials from the map's own factories,
// matched by fingerprint (programs.ts), and the plan numbers the MSL reads as float4 rows. The row
// layout is IV_HW_* in native/IronvaleApp/Shaders/MapSurface.h; keep the two in step.
import * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../../../src/game/contracts';
import { Kit } from '../../../../src/maps/headworks/kit';
import { lampGlow, lampLit, WALL_LAMPS } from '../../../../src/maps/headworks/lamps';
import { FOG_COLOR, HDRI_SUN, LIGHTING, SUN_COLOR } from '../../../../src/maps/headworks/lighting';
import { createMaterials } from '../../../../src/maps/headworks/materials';
import { HOUSES } from '../../../../src/maps/headworks/plan';
import { buildRange } from '../../../../src/maps/headworks/range';
import { buildSky } from '../../../../src/maps/headworks/sky';
import { shelter, skyVisibility } from '../../../../src/maps/headworks/surfaces';
import { graphKey, linear, namePrograms, type ProgramTable } from './programs';

/** sky.ts: brightness of the drawn panorama, or of the raw HDR when there is no panorama. */
const PANORAMA_GAIN = 1.15;
const HDR_GAIN = 0.8;

export function headworksPrograms(ctx: MapBuildContext): ProgramTable {
  const kit = new Kit(ctx);
  const materials = createMaterials(kit);
  buildSky(kit);
  buildRange(kit);
  const references: [string, THREE.Material][] = Object.entries(materials).filter((e): e is [string, THREE.Material] => e[1] instanceof THREE.Material);
  kit.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    if (mesh.material.side === THREE.BackSide) references.push(['sky', mesh.material]);
    else if (mesh.geometry instanceof THREE.CircleGeometry) references.push(['rangeFloor', mesh.material]);
    else references.push(['range', mesh.material]);
  });
  for (const name of ['sky', 'range', 'rangeFloor']) {
    if (!references.some(([n]) => n === name)) throw new Error(`headworks ${name} not found`);
  }
  const byFingerprint = namePrograms('headworks', references);

  const aoGraphs = new Map<string, string>();
  for (const withMap of [false, true]) {
    const probe = new THREE.MeshStandardNodeMaterial();
    if (withMap) probe.aoMap = new THREE.Texture();
    shelter(probe, skyVisibility());
    aoGraphs.set(graphKey(probe.aoNode, new Map(), new Set()), 'headworksSkyVisibility');
    probe.dispose();
  }
  const emissiveGraphs = new Map<string, string>();
  {
    const probe = new THREE.MeshStandardNodeMaterial();
    lampLit(probe, lampGlow());
    emissiveGraphs.set(graphKey(probe.emissiveNode, new Map(), new Set()), 'headworksLampGlow');
    probe.dispose();
  }
  const panorama = ctx.assets.sky(LIGHTING.hdri) !== null;
  kit.dispose();

  const sun = LIGHTING.sunDirection;
  const rows: number[][] = [
    [HOUSES.length, WALL_LAMPS.length, panorama ? PANORAMA_GAIN : HDR_GAIN, 0], // IV_HW_COUNTS
    [HDRI_SUN.x, HDRI_SUN.y, HDRI_SUN.z, 0], // IV_HW_HDRI_SUN
    [...linear(LIGHTING.fog.color), 0], // IV_HW_FOG
    [...linear(SUN_COLOR), 0], // IV_HW_SUN_COLOR
    [sun.x, sun.y, sun.z, 0], // IV_HW_SUN_DIRECTION
    [...linear(FOG_COLOR), 0], // IV_HW_RANGE_FOG
  ];
  for (const h of HOUSES) rows.push([h.x0, h.x1, h.z0, h.z1], [h.height, 0, 0, 0]); // IV_HW_HOUSES
  for (const lamp of WALL_LAMPS) {
    // lampGlow(): the glow sits 0.45 m out from the wall and 0.12 m under the lamp; high lamps reach further.
    rows.push(
      [lamp.x + lamp.nx * 0.45, lamp.y - 0.12, lamp.z + lamp.nz * 0.45, lamp.y > 3 ? 1 : 0],
      [...linear(lamp.color), 0],
      [lamp.nx, lamp.nz, 0, 0],
    );
  }
  return { byFingerprint, aoGraphs, emissiveGraphs, rows };
}
