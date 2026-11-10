/**
 * Soldier viewer. `/?view=characters/soldier&floor=0&state=aim&team=bravo`
 *
 * - `state`: idle, walk, jog, run, crouch, crouchwalk, aim, aimwalk, fire,
 *   reload, flinch, die (default idle)
 * - `t`: seconds into the state (the viewer freezes time there)
 * - `team`: alpha or bravo; `lineup=1` shows both teams side by side
 * - `aimpitch`: aim pitch in degrees; `zone`: head, torso or limb for flinch
 * - `dir`: bullet direction in degrees for die (0 = shot from the front,
 *   90 = from the soldier's right, 180 = from behind)
 * - `move`: travel direction in degrees off the facing (90 = strafing left)
 * - `count`: a grid of that many soldiers, for performance checks
 */
import * as THREE from 'three/webgpu';
import type { HitZone, SoldierVisual, Team } from '../game/contracts';
import type { Viewable } from '../dev/viewer';
import { createSoldier, soldierAssets } from './index';
import type { Soldier } from './soldier';

const params = new URLSearchParams(location.search);
const DEG = Math.PI / 180;
const STEP = 1 / 60;
/** Seconds of settling before a flinch or death is triggered, so blends have finished. */
const LEAD_IN = 1;

interface Preset {
  speed: number;
  crouching?: boolean;
  aiming?: boolean;
  firing?: boolean;
  reloading?: boolean;
}

const PRESETS: Record<string, Preset> = {
  idle: { speed: 0 },
  walk: { speed: 1.7 },
  jog: { speed: 3.4 },
  run: { speed: 5.2 },
  crouch: { speed: 0, crouching: true, aiming: true },
  crouchwalk: { speed: 1.8, crouching: true, aiming: true },
  aim: { speed: 0, aiming: true },
  aimwalk: { speed: 1.7, aiming: true },
  fire: { speed: 0, aiming: true, firing: true },
  reload: { speed: 0, reloading: true },
  flinch: { speed: 0, aiming: true },
  die: { speed: 0, aiming: true },
};

interface Actor {
  visual: SoldierVisual;
  time: number;
  triggered: boolean;
}

const stateName = params.get('state') ?? 'idle';
const preset = PRESETS[stateName] ?? PRESETS.idle!;
const pitch = Number(params.get('aimpitch') ?? 0) * DEG;
const moveAngle = Number(params.get('move') ?? 0) * DEG;
const actors: Actor[] = [];
// For scripts/dev/characters-shots.mjs --eval, which measures poses in the page.
(window as unknown as { __soldiers: Actor[] }).__soldiers = actors;

function stepActor(actor: Actor, dt: number): void {
  const { visual } = actor;
  if (preset.speed > 0 && params.has('move')) {
    // Travel for real so the soldier can read its heading; the camera target stays put.
    visual.root.position.x += -Math.sin(moveAngle) * preset.speed * dt;
    visual.root.position.z += -Math.cos(moveAngle) * preset.speed * dt;
  }
  visual.setState({
    speed: preset.speed,
    crouching: preset.crouching ?? false,
    aimPitch: pitch,
    aiming: preset.aiming ?? false,
    firing: preset.firing ?? false,
    reloading: preset.reloading ?? false,
  });
  actor.time += dt;
  if (!actor.triggered && actor.time >= LEAD_IN) {
    actor.triggered = true;
    if (stateName === 'flinch') visual.flinch((params.get('zone') ?? 'torso') as HitZone);
    if (stateName === 'die') {
      const dir = Number(params.get('dir') ?? 0) * DEG;
      // Soldiers face their own -Z, so a shot from the front travels along their +Z.
      visual.die(new THREE.Vector3(-Math.sin(dir), 0, Math.cos(dir)).applyQuaternion(visual.root.quaternion));
    }
  }
  visual.update(dt);
}

const viewable: Viewable = {
  assets: soldierAssets(),
  create(assets) {
    const group = new THREE.Group();
    const count = Number(params.get('count') ?? 0);
    const lineup = params.has('lineup');
    const teams: Team[] = lineup ? ['alpha', 'bravo'] : [(params.get('team') ?? 'bravo') as Team];
    const total = count > 0 ? count : teams.length;
    for (let i = 0; i < total; i++) {
      const visual = createSoldier(assets, count > 0 ? (i % 2 ? 'alpha' : 'bravo') : teams[i]!);
      if (count > 0) visual.root.position.set(((i % 4) - 1.5) * 1.6, 0, -Math.floor(i / 4) * 2.2);
      else visual.root.position.x = (i - (total - 1) / 2) * 1.1;
      // Face the default camera (+Z side) unless told otherwise.
      visual.root.rotation.y = Number(params.get('face') ?? 180) * DEG;
      group.add(visual.root);
      actors.push({ visual, time: 0, triggered: false });
    }
    return group;
  },
  update(_object, dt, elapsed) {
    if (dt > 0) {
      for (const actor of actors) stepActor(actor, dt);
      return;
    }
    // Frozen time: run the simulation forward to `elapsed` in fixed steps.
    const target = elapsed + LEAD_IN;
    for (const actor of actors) {
      const home = actor.visual.root.position.clone();
      while (actor.time < target - 1e-6) stepActor(actor, Math.min(STEP, target - actor.time));
      // Bring a travelling soldier back in front of the camera without disturbing its pose.
      actor.visual.root.position.copy(home);
      (actor.visual as Soldier).refresh();
    }
  },
};

export default viewable;
