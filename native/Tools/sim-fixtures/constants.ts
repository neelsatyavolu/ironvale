/**
 * Simulation constants the native IronvaleSim reads from native/Contract/sim/sim.json instead of
 * hand-copying them (PLAN.md section 10). Exported values are imported; module-private constants
 * are read with contract-export's parser. Two shapes that parser does not evaluate
 * (`MathUtils.degToRad(n)` and `new Vector3(x, y, z)`) are matched here by a strict pattern that
 * throws when the source no longer has that shape.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BINDING_PRESETS } from '../../../src/core/input';
import { CONTROL_PRESETS, DEFAULT_SETTINGS } from '../../../src/core/settings';
import { GRENADES_PER_MATCH } from '../../../src/weapons/grenade-hand';
import { BLAST_LIFT } from '../../../src/weapons/grenade-math';
import {
  HANDLING,
  SPRINT_HOLD_OFF_SECONDS,
  SPRINT_IN_SECONDS,
  SPRINT_OUT_SECONDS,
  SPRINT_READY_BLEND,
} from '../../../src/weapons/handling';
import { extractConsts } from '../contract-export/extract-consts';

function sourceText(repoRoot: string, file: string): string {
  return readFileSync(resolve(repoRoot, file), 'utf8');
}

/** `const NAME = MathUtils.degToRad(n);` evaluated as three does: `n * (Math.PI / 180)`. */
function degConst(repoRoot: string, file: string, name: string): number {
  const match = new RegExp(`const ${name} = MathUtils\\.degToRad\\((-?[\\d.]+)\\);`).exec(sourceText(repoRoot, file));
  if (!match) throw new Error(`${file}: ${name} is no longer MathUtils.degToRad(<number>)`);
  return Number(match[1]) * (Math.PI / 180);
}

/** `const NAME = new Vector3(x, y, z);` as [x, y, z]. */
function vectorConst(repoRoot: string, file: string, name: string): number[] {
  const match = new RegExp(`const ${name} = new Vector3\\((-?[\\d.]+), (-?[\\d.]+), (-?[\\d.]+)\\);`).exec(
    sourceText(repoRoot, file),
  );
  if (!match) throw new Error(`${file}: ${name} is no longer new Vector3(<x>, <y>, <z>)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function simConstants(repoRoot: string): Record<string, unknown> {
  const x = (file: string, names: string[]) => extractConsts(repoRoot, file, names);
  const controller = 'src/player/controller.ts';
  return {
    controller: {
      ...x(controller, [
        'RADIUS',
        'STAND_HEIGHT',
        'CROUCH_HEIGHT',
        'STAND_EYE',
        'CROUCH_EYE',
        'WALK_SPEED',
        'SPRINT_SPEED',
        'CROUCH_SPEED',
        'AIM_SPEED_FACTOR',
        'GROUND_ACCEL',
        'AIR_ACCEL',
        'FRICTION',
        'GRAVITY',
        'JUMP_SPEED',
        'COYOTE_TIME',
        'STRIDE_WALK',
        'STRIDE_RUN',
        'REGEN_DELAY',
        'REGEN_PER_SECOND',
      ]),
      MAX_PITCH: degConst(repoRoot, controller, 'MAX_PITCH'),
    },
    engine: x('src/render/engine.ts', ['MAX_FRAME_DT']),
    machine: x('src/weapons/machine.ts', ['PRESS_BUFFER']),
    plans: x('src/weapons/plans.ts', [
      'HANDS_LEAD',
      'HANDS_TAIL',
      'CHARGE_SECONDS',
      'TACTICAL_FACTOR',
      'BOLT_TOP_UP_FACTOR',
      'BOLT_CYCLE',
    ]),
    recoil: x('src/weapons/recoil.ts', [
      'GROWTH_PER_SHOT',
      'MAX_HEAT',
      'HEAT_HOLD_SECONDS',
      'HEAT_DRAIN_PER_SECOND',
      'AIMED_KICK',
      'CROUCHED',
      'BLOOM_PER_SHOT',
      'MAX_BLOOM',
      'BLOOM_RECOVERY',
      'AIMED_BLOOM',
      'AIMED_MOVE',
      'FULL_MOVE_SPEED',
      'AIR_SPREAD_FACTOR',
      'AIR_SPREAD_MIN',
      'KICK_APPLY_RATE',
      'KICK_RETURN_RATE',
    ]),
    aim: x('src/weapons/aim.ts', ['LOWER_SPEEDUP']),
    grenadeMath: {
      ...x('src/weapons/grenade-math.ts', ['REST_NORMAL_Y', 'LOOKAHEAD_RADII', 'CONTACTS_PER_STEP']),
      BLAST_LIFT,
    },
    grenades: x('src/weapons/grenades.ts', [
      'POOL_SIZE',
      'MAX_STEPS_PER_FRAME',
      'BOUNCE_GAP_SECONDS',
      'DETONATE_GRACE_SECONDS',
      'DETONATE_TOLERANCE',
      'CHEST_SHARE',
    ]),
    grenadeHand: {
      GRENADES_PER_MATCH,
      ...x('src/weapons/grenade-hand.ts', ['LOWER_SECONDS', 'RAISE_SECONDS', 'FOLLOW_THROUGH_SECONDS']),
    },
    grenadeThrow: { HAND_OFFSET: vectorConst(repoRoot, 'src/weapons/grenade-throw.ts', 'HAND_OFFSET') },
    ballistics: x('src/weapons/ballistics.ts', [
      'INSTANT_RANGE',
      'NEAR_MISS_RADIUS',
      'CASING_BEHIND_MUZZLE',
      'CASING_SIDE_SPEED',
      'CASING_UP_SPEED',
      'BOLT_EJECT_DELAY',
    ]),
    handling: {
      classes: JSON.parse(JSON.stringify(HANDLING)),
      SPRINT_IN_SECONDS,
      SPRINT_OUT_SECONDS,
      SPRINT_READY_BLEND,
      SPRINT_HOLD_OFF_SECONDS,
    },
    playerWeapons: x('src/weapons/player-weapons.ts', ['SCOPED_AT', 'GRENADE_READY', 'DEFAULT_SWITCH_TIMES']),
    loadout: x('src/weapons/loadout.ts', ['RESERVED']),
    game: x('src/game/game.ts', [
      'PLAYER_LIVES',
      'SURVIVAL_SOLO_LIVES',
      'WIN_DELAY_SECONDS',
      'RESPAWN_SECONDS',
      'SNAPSHOT_INTERVAL',
      'KILL_FEED_SECONDS',
      'SURVIVAL_WAVE_GROWTH',
      'SURVIVAL_WAVE_PAUSE',
      'DEFAULT_KILL_TARGET',
    ]),
    input: {
      bindings: JSON.parse(JSON.stringify(BINDING_PRESETS)),
      controlPresets: JSON.parse(JSON.stringify(CONTROL_PRESETS)),
      defaultGameplay: { fov: DEFAULT_SETTINGS.gameplay.fov, headBob: DEFAULT_SETTINGS.gameplay.headBob },
      ...x('src/core/input.ts', ['WHEEL_THRESHOLD', 'WHEEL_QUIET_MS', 'LOOK_SPIKE_PX']),
    },
  };
}
