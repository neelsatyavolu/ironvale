import type { WeaponDef } from '../../game/contracts';

/** A pose offset in camera space: metres right/up/back, radians pitch (muzzle up), yaw (muzzle left), roll (top to the left). */
export interface PoseOffset {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
}

function pose(x: number, y: number, z: number, pitch: number, yaw: number, roll: number): PoseOffset {
  return { x, y, z, pitch, yaw, roll };
}

/** Gun carried low across the body while sprinting. */
const SPRINT_LONG = pose(-0.03, 0.03, 0.03, -0.1, 0.36, 0.22);
const SPRINT_PISTOL = pose(-0.02, 0.0, 0.06, 0.4, 0.2, 0.12);

/** Gun dropped out of view while switching. */
export const LOWERED = pose(0.0, -0.3, 0.04, -0.7, 0.0, 0.2);

/**
 * Gun swung up and in when a wall is closer than the barrel. Scaled by the
 * angle (radians) the barrel has to turn away to fit in the space left.
 */
export const AGAINST_WALL = pose(0, -0.03, 0.07, 0.85, 0.5, 0);

const RELOAD_MAGAZINE = pose(-0.02, 0.065, 0.0, 0.13, 0.06, 0.42);
const RELOAD_PISTOL = pose(-0.02, 0.02, 0.04, 0.2, 0.08, 0.35);
const RELOAD_ENBLOC = pose(-0.02, 0.03, 0.02, 0.12, 0.08, 0.14);
const RELOAD_SHELLS = pose(-0.02, 0.05, 0.02, 0.14, 0.08, 0.48);
const RELOAD_BELT = pose(-0.02, 0.05, 0.0, 0.08, 0.06, 0.26);
const RELOAD_BOLT_GUN = pose(-0.01, 0.0, 0.02, 0.1, 0.05, 0.3);

const WORK_BOLT = pose(-0.01, -0.012, 0.025, 0.05, 0.03, -0.18);
const WORK_PUMP = pose(0, -0.008, 0.012, 0.04, 0, -0.06);
const WORK_CHARGE = pose(0, 0, 0.01, 0.05, 0.03, 0.12);

export function sprintPose(def: WeaponDef): PoseOffset {
  return def.weaponClass === 'pistol' ? SPRINT_PISTOL : SPRINT_LONG;
}

export function reloadPose(def: WeaponDef): PoseOffset {
  switch (def.reloadStyle) {
    case 'enbloc':
      return RELOAD_ENBLOC;
    case 'single-shell':
      return RELOAD_SHELLS;
    case 'belt':
      return RELOAD_BELT;
    case 'magazine':
      if (def.weaponClass === 'pistol') return RELOAD_PISTOL;
      return def.fireMode === 'bolt' ? RELOAD_BOLT_GUN : RELOAD_MAGAZINE;
  }
}

/** Cant while the hands work the action between shots. */
export function workPose(def: WeaponDef): PoseOffset {
  if (def.fireMode === 'bolt') return WORK_BOLT;
  if (def.fireMode === 'pump') return WORK_PUMP;
  return WORK_CHARGE;
}
