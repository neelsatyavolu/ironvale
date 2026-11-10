import type { Action, Input } from '../core/input';

/** What the player is asking the weapon to do this frame. */
export interface WeaponIntent {
  fireHeld: boolean;
  firePressed: boolean;
  aimHeld: boolean;
  aimPressed: boolean;
  reloadPressed: boolean;
  holdBreath: boolean;
  sprintPressed: boolean;
  /** Loadout slot asked for this frame (1 - 7), or 0. */
  slot: number;
  /** +1 next weapon, -1 previous, 0 none. */
  cycle: number;
}

/**
 * Scripted input for development and screenshots: set on the weapon system as
 * `debugInput` to drive the gun without pointer lock. Held values stay until
 * changed; `reload`, `slot` and `cycle` act once each time they are set.
 */
export interface DebugInput {
  fire?: boolean;
  aim?: boolean;
  holdBreath?: boolean;
  reload?: boolean;
  slot?: number;
  /** +1 next weapon, -1 previous. */
  cycle?: number;
}

const SLOT_ACTIONS: readonly Action[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7'];

/** Turns device input (or scripted input) into a `WeaponIntent`. One reused object, no allocation. */
export class IntentReader {
  debug: DebugInput | null = null;
  private readonly intent: WeaponIntent = {
    fireHeld: false,
    firePressed: false,
    aimHeld: false,
    aimPressed: false,
    reloadPressed: false,
    holdBreath: false,
    sprintPressed: false,
    slot: 0,
    cycle: 0,
  };

  /** `active` is false while the player cannot act (menus, death, no pointer lock). */
  read(input: Input, active: boolean): WeaponIntent {
    const intent = this.intent;
    const debug = this.debug;
    if (debug) {
      const fire = debug.fire === true;
      const aim = debug.aim === true;
      intent.firePressed = fire && !intent.fireHeld;
      intent.fireHeld = fire;
      intent.aimPressed = aim && !intent.aimHeld;
      intent.aimHeld = aim;
      intent.holdBreath = debug.holdBreath === true;
      intent.reloadPressed = debug.reload === true;
      intent.slot = debug.slot ?? 0;
      intent.sprintPressed = false;
      intent.cycle = debug.cycle ?? 0;
      debug.reload = false;
      debug.slot = 0;
      debug.cycle = 0;
      return intent;
    }
    if (!active) {
      intent.fireHeld = intent.firePressed = intent.aimHeld = intent.aimPressed = false;
      intent.reloadPressed = intent.holdBreath = intent.sprintPressed = false;
      intent.slot = intent.cycle = 0;
      return intent;
    }
    intent.fireHeld = input.isDown('fire');
    intent.firePressed = input.wasPressed('fire');
    intent.aimHeld = input.isDown('aim');
    intent.aimPressed = input.wasPressed('aim');
    intent.reloadPressed = input.wasPressed('reload');
    intent.holdBreath = input.isDown('holdBreath');
    intent.sprintPressed = input.wasPressed('sprint');
    intent.slot = 0;
    for (let i = 0; i < SLOT_ACTIONS.length; i++) {
      if (input.wasPressed(SLOT_ACTIONS[i]!)) intent.slot = i + 1;
    }
    intent.cycle = Number(input.wasPressed('weaponNext')) - Number(input.wasPressed('weaponPrev'));
    return intent;
  }
}
