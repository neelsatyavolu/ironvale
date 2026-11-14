// Test range surface programs (PLAN.md 3.4, M9): the only node material is the wet concrete of
// src/render/materials.ts pbrMaterial({ wetness }), whose wetness and puddle scale are rows here
// (IV_RG_* in native/IronvaleApp/Shaders/MapSurface.h).
import type * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../../../src/game/contracts';
import { pbrMaterial } from '../../../../src/render/materials';
import { namePrograms, type ProgramTable } from './programs';

/** src/maps/range/index.ts: the ground concrete's wetness; pbrMaterial's default puddle scale. */
const WETNESS = 0.7;
const PUDDLE_SCALE = 3;

export function rangePrograms(ctx: MapBuildContext): ProgramTable {
  const wet = pbrMaterial(ctx.assets.pbr('pbr-test-concrete'), { wetness: WETNESS });
  const references: [string, THREE.Material][] = [['wetConcrete', wet]];
  const byFingerprint = namePrograms('range', references);
  wet.dispose();
  return { byFingerprint, aoGraphs: new Map(), rows: [[WETNESS, PUDDLE_SCALE, 0, 0]] };
}
