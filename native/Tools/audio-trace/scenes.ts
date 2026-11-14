/**
 * The 20 scripted scenes of the M8a audio trace (PLAN.md section 7). Each scene is a fully
 * resolved input: per-frame clock, camera matrix, player state, settings and the GameEvents and
 * AudioSystem calls made in that frame. The Swift harness replays exactly these inputs.
 */
import { Euler, Matrix4, Vector3 } from 'three/webgpu';
import type { ReverbPreset } from '../../../src/world/types';
import { WEAPON_DEFS } from '../../../src/weapons/defs';

export type Vec = [number, number, number];

export interface SceneWeapon {
  readonly id: string;
  readonly weaponClass: string;
  readonly loudness: number;
  readonly muzzleVelocity: number;
}

export interface SceneMap {
  readonly reverb: ReverbPreset;
  readonly weather: 'clear' | 'rain' | 'mist';
  readonly ambience: readonly { sound: string; volume: number; position?: Vec; radius?: number }[];
  readonly interiors: readonly { min: Vec; max: Vec; reverb: ReverbPreset }[];
}

export interface SceneSettings {
  readonly master: number;
  readonly effects: number;
  readonly ambience: number;
  readonly interface: number;
  readonly hrtf: boolean;
  readonly showHitMarkers: boolean;
}

export type Action = Record<string, unknown> & { readonly op: string };

export interface Frame {
  readonly time: number;
  readonly dt: number;
  readonly camera: number[];
  readonly indoors: boolean;
  readonly crouching: boolean;
  /** Present on the frames where settings change (a new object, as the web's settings store makes). */
  readonly settings?: SceneSettings;
  readonly combatants?: Record<string, { position: Vec; crouching: boolean }>;
  readonly actions: Action[];
}

export interface Scene {
  readonly name: string;
  readonly seed: number;
  readonly playerId: number;
  readonly map: SceneMap;
  readonly occluders: readonly { min: Vec; max: Vec }[];
  readonly settings: SceneSettings;
  readonly combatants: Record<string, { position: Vec; crouching: boolean }>;
  readonly frames: Frame[];
}

const DEFAULT_SETTINGS: SceneSettings = { master: 0.9, effects: 1, ambience: 0.8, interface: 0.7, hrtf: true, showHitMarkers: true };

const OPEN: SceneMap = { reverb: 'open-field', weather: 'clear', ambience: [], interiors: [] };

const RAILYARD_LIKE: SceneMap = {
  reverb: 'industrial',
  weather: 'rain',
  ambience: [
    { sound: 'snd-amb-industrial', volume: 0.55 },
    { sound: 'snd-amb-wind', volume: 0.35 },
    { sound: 'snd-loop-generator', volume: 0.7, position: [40.2, 0.8, 21.6], radius: 22 },
    { sound: 'snd-loop-generator', volume: 0.55, position: [-38.5, 0.8, -43], radius: 18 },
    { sound: 'snd-loop-water-lap', volume: 0.6, position: [2, -1.5, 30], radius: 30 },
    { sound: 'snd-loop-metal-creak', volume: 0.5, position: [12, 11, 6], radius: 28 },
  ],
  interiors: [
    { min: [-20, 0, -10], max: [0, 9, 10], reverb: 'industrial' },
    { min: [10, 0, -30], max: [20, 4, -20], reverb: 'interior' },
  ],
};

const HARBOR_LIKE: SceneMap = {
  reverb: 'street',
  weather: 'clear',
  ambience: [
    { sound: 'snd-amb-harbor', volume: 0.6 },
    { sound: 'snd-loop-water-lap', volume: 0.5, position: [0, -1, 12], radius: 26 },
    { sound: 'snd-loop-birds', volume: 0.4, position: [-25, 6, -5], radius: 35 },
  ],
  interiors: [{ min: [30, 0, -5], max: [42, 5, 5], reverb: 'interior' }],
};

const FOREST_LIKE: SceneMap = {
  reverb: 'forest',
  weather: 'mist',
  ambience: [{ sound: 'snd-amb-forest', volume: 0.7 }],
  interiors: [],
};

export function weapon(id: keyof typeof WEAPON_DEFS): SceneWeapon {
  const def = WEAPON_DEFS[id];
  return { id: def.id, weaponClass: def.weaponClass, loudness: def.loudness, muzzleVelocity: def.muzzleVelocity };
}

/** A weapon the catalog has no recordings for, to exercise the class stand-ins. */
function unknownWeapon(weaponClass: string): SceneWeapon {
  return { id: `test-${weaponClass}`, weaponClass, loudness: 0.6, muzzleVelocity: 400 };
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Builder {
  readonly frames: Frame[] = [];
  private time = 0;
  position: Vec = [0, 1.6, 0];
  yaw = 0;
  pitch = 0;
  indoors = false;
  crouching = false;
  private pendingSettings: SceneSettings | undefined;
  private pendingCombatants: Record<string, { position: Vec; crouching: boolean }> | undefined;
  readonly rand: () => number;

  constructor(seed: number) {
    this.rand = seeded(seed ^ 0x9e3779b9);
  }

  camera(): number[] {
    const m = new Matrix4().makeRotationFromEuler(new Euler(this.pitch, this.yaw, 0, 'YXZ'));
    m.setPosition(new Vector3(...this.position));
    return [...m.elements];
  }

  settings(settings: SceneSettings): void {
    this.pendingSettings = settings;
  }

  combatants(value: Record<string, { position: Vec; crouching: boolean }>): void {
    this.pendingCombatants = value;
  }

  /** One frame with these actions. */
  step(actions: Action[] = [], dt = 1 / 60): void {
    this.time += dt;
    this.frames.push({
      time: this.time,
      dt,
      camera: this.camera(),
      indoors: this.indoors,
      crouching: this.crouching,
      ...(this.pendingSettings ? { settings: this.pendingSettings } : {}),
      ...(this.pendingCombatants ? { combatants: this.pendingCombatants } : {}),
      actions,
    });
    this.pendingSettings = undefined;
    this.pendingCombatants = undefined;
  }

  wait(seconds: number, dt = 1 / 60): void {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) this.step([], dt);
  }
}

const ev = (type: string, payload: Record<string, unknown>): Action => ({ op: 'event', type, ...payload });

function shot(shooterId: number, w: SceneWeapon, muzzle: Vec, local: boolean): Action {
  return ev('shotFired', { shooterId, weapon: w, muzzle, direction: [0, 0, -1], local });
}

function around(rand: () => number, radius: number, y = 1.5): Vec {
  const a = rand() * Math.PI * 2;
  const r = radius * (0.3 + 0.7 * rand());
  return [Math.cos(a) * r, y, Math.sin(a) * r];
}

interface SceneSpec {
  readonly name: string;
  readonly map?: SceneMap;
  readonly occluders?: readonly { min: Vec; max: Vec }[];
  readonly settings?: SceneSettings;
  readonly combatants?: Record<string, { position: Vec; crouching: boolean }>;
  readonly script: (b: Builder) => void;
}

const PLAYER = 1;
const M4 = weapon('m4a1');
const MP5 = weapon('mp5');
const M24 = weapon('m24');
const M249 = weapon('m249');
const M7 = weapon('m7');
const SCAR = weapon('scarh');
const ALL = [M4, MP5, M24, M249, M7, SCAR];
const STAGES = ['magOut', 'magIn', 'boltBack', 'boltForward', 'boltLift', 'boltClose', 'shellInsert', 'beltOpen', 'beltClose'];
const SURFACES = ['concrete', 'cobble', 'asphalt', 'gravel', 'dirt', 'grass', 'sand', 'wood', 'metal', 'plaster', 'glass', 'water', 'foliage', 'flesh'];

const SPECS: readonly SceneSpec[] = [
  {
    name: 'local-auto-burst',
    script: (b) => {
      b.wait(0.2);
      for (let i = 0; i < 14; i++) {
        b.step([shot(PLAYER, M4, [0, 1.5, -0.6], true)]);
        b.wait(0.08);
      }
      b.wait(1.5);
      for (let i = 0; i < 5; i++) {
        b.step([shot(PLAYER, M249, [0, 1.5, -0.6], true)]);
        b.wait(0.07);
      }
      b.wait(1);
    },
  },
  {
    name: 'remote-distances',
    script: (b) => {
      b.wait(0.1);
      for (const d of [4, 12, 34, 50, 80, 129, 160, 300, 520, 650, 699, 720]) {
        b.step([shot(7, M24, [d * 0.6, 1.5, -d * 0.8], false)]);
        b.wait(0.3);
      }
      b.wait(2.5);
    },
  },
  {
    name: 'occlusion-and-ray-budget',
    occluders: [{ min: [-3, 0, -12], max: [3, 6, -10] }, { min: [8, 0, -2], max: [9, 4, 2] }],
    script: (b) => {
      b.wait(0.1);
      b.step([shot(3, M4, [0, 1.5, -20], false), shot(4, MP5, [20, 1.5, 0], false)]);
      b.wait(0.2);
      // Eight shooters in one frame: the budget of five rays runs out.
      b.step(Array.from({ length: 8 }, (_, i) => shot(10 + i, i % 2 ? M4 : M249, [-5 + i * 1.5, 1.4, -25], false)));
      b.step([ev('bulletImpact', { shooterId: 3, weapon: M4, hit: { point: [0, 1, -13], normal: [0, 0, 1], distance: 13, surface: 'concrete' } })]);
      b.wait(0.5);
      b.position = [0, 1.6, -30];
      b.step([shot(3, M4, [0, 1.5, -20], false)]);
      b.wait(1.2);
    },
  },
  {
    name: 'near-misses',
    script: (b) => {
      b.wait(0.1);
      const points: Vec[] = [[1, 1.6, -0.5], [-0.8, 1.7, 0.4], [0, 1.6, -2], [3, 1.5, 0], [-0.1, 1.6, 1]];
      for (const [i, p] of points.entries()) {
        b.step([ev('nearMiss', { point: p, direction: [1, 0, 0], weapon: i % 2 ? MP5 : M24 })]);
        b.step([ev('nearMiss', { point: p, direction: [1, 0, 0], weapon: M4 })]);
        b.wait(0.1);
      }
      b.yaw = 1.2;
      b.step([ev('nearMiss', { point: [0.5, 1.6, 0.2], direction: [0, 0, 1], weapon: SCAR })]);
      b.wait(1);
    },
  },
  {
    name: 'impacts-and-ricochets',
    script: (b) => {
      b.wait(0.1);
      for (let round = 0; round < 6; round++) {
        b.step(
          SURFACES.slice(round * 2, round * 2 + 6).map((surface, i) =>
            ev('bulletImpact', { shooterId: 5, weapon: M4, hit: { point: [i * 2 - 5, 0.2, -8 - round * 3], normal: [0, 1, 0], distance: 9, surface } }),
          ),
        );
        b.wait(0.12);
      }
      for (let i = 0; i < 30; i++) {
        b.step([ev('bulletImpact', { shooterId: 5, weapon: M249, hit: { point: [b.rand() * 10 - 5, 0, -6], normal: [0, 1, 0], distance: 6, surface: SURFACES[i % 4]! } })]);
      }
      b.wait(1);
    },
  },
  {
    name: 'combatant-hits-and-ticks',
    combatants: { '2': { position: [0, 0, -10], crouching: false }, '3': { position: [5, 0, -15], crouching: false } },
    script: (b) => {
      b.wait(0.1);
      const hit = (attackerId: number, targetId: number, fatal: boolean) =>
        ev('combatantHit', { weapon: M4, targetId, attackerId, hit: { point: [0, 1.4, -10], zone: 'torso' }, direction: [0, 0, -1], fatal });
      b.step([hit(PLAYER, 2, false)]);
      b.step([hit(PLAYER, 2, false)]);
      b.wait(0.06);
      b.step([hit(PLAYER, 2, false), hit(PLAYER, 3, true)]);
      b.step([hit(3, 2, false), hit(2, PLAYER, false)]);
      b.wait(0.2);
      b.settings({ ...DEFAULT_SETTINGS, showHitMarkers: false });
      b.step([hit(PLAYER, 2, true)]);
      b.wait(0.5);
    },
  },
  {
    name: 'weapon-handling',
    combatants: { '4': { position: [6, 0, -3], crouching: false } },
    script: (b) => {
      b.wait(0.1);
      for (const w of [...ALL, unknownWeapon('rifle'), unknownWeapon('shotgun'), unknownWeapon('pistol')]) {
        for (const stage of STAGES) {
          b.step([ev('weaponAction', { shooterId: PLAYER, weapon: w, stage, position: [0, 1.4, 0], local: true })]);
          b.step([ev('weaponAction', { shooterId: 4, weapon: w, stage, position: [6, 1.4, -3], local: false })]);
        }
        b.step([ev('weaponSwitch', { shooterId: PLAYER, weapon: w, local: true }), ev('weaponSwitch', { shooterId: 4, weapon: w, local: false }), ev('weaponSwitch', { shooterId: 99, weapon: w, local: false })]);
        b.step([ev('dryFire', { shooterId: PLAYER, weapon: w, position: [0, 1.4, 0] }), ev('dryFire', { shooterId: 4, weapon: w, position: [6, 1.4, -3] })]);
        b.step([ev('aimChanged', { aiming: true, weapon: w })]);
        b.wait(0.15);
        b.step([ev('aimChanged', { aiming: false, weapon: w })]);
      }
      b.wait(1);
    },
  },
  {
    name: 'footsteps-jumps-landings',
    combatants: { '6': { position: [3, 0, -4], crouching: true }, '7': { position: [-8, 0, -9], crouching: false } },
    script: (b) => {
      b.wait(0.1);
      for (const [i, surface] of SURFACES.entries()) {
        const running = i % 3 !== 0;
        b.crouching = i % 5 === 4;
        b.step([ev('footstep', { ownerId: PLAYER, position: [0, 0, 0], surface, running, local: true })]);
        b.step([ev('footstep', { ownerId: 6, position: [3, 0, -4], surface, running, local: false }), ev('footstep', { ownerId: 7, position: [-8, 0, -9], surface, running: !running, local: false })]);
        b.wait(0.18);
      }
      b.crouching = false;
      for (const speed of [0.5, 2, 4.5, 9, 14]) {
        b.step([ev('jumped', { ownerId: PLAYER, position: [0, 0, 0], local: true }), ev('jumped', { ownerId: 7, position: [-8, 0, -9], local: false })]);
        b.wait(0.4);
        b.step([ev('landed', { ownerId: PLAYER, position: [0, 0, 0], surface: SURFACES[Math.floor(speed) % 14]!, speed, local: true })]);
        b.step([ev('landed', { ownerId: 7, position: [-8, 0, -9], surface: 'wood', speed, local: false })]);
        b.wait(0.2);
      }
      b.wait(1);
    },
  },
  {
    name: 'hurt-heartbeat-death',
    script: (b) => {
      b.step([ev('matchState', { phase: 'playing', health: 100 })]);
      b.wait(0.2);
      for (const [health, dir] of [[80, [1, 0, 0]], [55, [-1, 0, 0.2]], [35, [0, 0, -1]], [20, [0.6, 0, 0.8]], [8, [-0.3, 0, -0.9]]] as const) {
        b.step([ev('playerHurt', { amount: 100 - health, health, direction: dir }), ev('matchState', { phase: 'playing', health })]);
        b.step([ev('playerHurt', { amount: 5, health, direction: dir })]);
        b.wait(1.4);
      }
      b.step([ev('died', { victimId: PLAYER, killerId: 4, weaponId: 'm4a1', headshot: false }), ev('matchState', { phase: 'playing', health: 0 })]);
      b.wait(1);
      b.step([ev('matchState', { phase: 'playing', health: 100 })]);
      b.wait(0.5);
    },
  },
  {
    name: 'bots-voices',
    combatants: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(20 + i), { position: [i * 3 - 10, 0, -12 - i], crouching: false }])),
    script: (b) => {
      b.wait(0.1);
      const kinds = ['spotted', 'reloading', 'hurt', 'death'];
      for (let i = 0; i < 24; i++) {
        const id = 20 + (i % 8);
        b.step([ev('botCallout', { botId: id, kind: kinds[i % 4], position: [(i % 8) * 3 - 10, 0, -12 - (i % 8)] })]);
        b.wait(i % 3 === 0 ? 0.7 : 0.2);
      }
      for (let i = 0; i < 6; i++) b.step([ev('died', { victimId: 20 + i, killerId: PLAYER, weaponId: 'm4a1', headshot: i % 2 === 0 }), ev('died', { victimId: 77, killerId: PLAYER, weaponId: 'mp5', headshot: false })]);
      b.wait(1.5);
    },
  },
  {
    name: 'grenades',
    occluders: [{ min: [40, 0, -5], max: [42, 5, 5] }],
    script: (b) => {
      b.wait(0.1);
      b.step([ev('grenadeThrown', { ownerId: PLAYER, position: [0, 1.5, 0], velocity: [0, 4, -12], local: true })]);
      b.step([ev('grenadeThrown', { ownerId: 9, position: [10, 1.5, -10], velocity: [0, 4, 12], local: false })]);
      for (const [i, surface] of ['concrete', 'dirt', 'metal', 'grass', 'water', 'wood'].entries()) {
        b.step([ev('grenadeBounced', { ownerId: PLAYER, position: [0, 0.1, -5 - i], speed: 1 + i * 1.6, surface })]);
        b.wait(0.15);
      }
      for (const d of [4, 25, 59, 70, 105, 200, 480, 880, 950]) {
        b.step([ev('grenadeExploded', { ownerId: 9, position: d === 59 ? [50, 0, 0] : [d * 0.8, 0, -d * 0.6], local: false })]);
        b.wait(0.5);
      }
      b.wait(3);
    },
  },
  {
    name: 'voice-stealing',
    script: (b) => {
      b.wait(0.1);
      // A firefight past the 32-voice limit: groups capped, low priority stolen first, loops never.
      for (let f = 0; f < 90; f++) {
        const actions: Action[] = [];
        for (let k = 0; k < 4; k++) {
          const id = 30 + Math.floor(b.rand() * 12);
          actions.push(shot(id, ALL[id % 6]!, around(b.rand, 60), false));
        }
        actions.push(ev('casingLanded', { kind: f % 3 ? 'rifle' : 'pistol', position: around(b.rand, 4, 0), surface: SURFACES[f % 14]! }));
        actions.push(ev('aimChanged', { aiming: f % 2 === 0, weapon: M4 }));
        if (f % 5 === 0) actions.push(shot(PLAYER, M249, [0, 1.5, -0.6], true));
        b.step(actions);
      }
      b.wait(2);
    },
  },
  {
    name: 'hrtf-assignment',
    script: (b) => {
      b.wait(0.1);
      for (let i = 0; i < 14; i++) {
        b.step([ev('footstep', { ownerId: 40 + i, position: around(b.rand, 20, 0), surface: 'gravel', running: true, local: false }), shot(40 + i, MP5, around(b.rand, 40), false)]);
        b.wait(0.03);
      }
      b.settings({ ...DEFAULT_SETTINGS, hrtf: false });
      b.step();
      for (let i = 0; i < 6; i++) b.step([shot(60 + i, M4, around(b.rand, 30), false)]);
      b.settings({ ...DEFAULT_SETTINGS, hrtf: true });
      b.step();
      for (let i = 0; i < 6; i++) b.step([shot(70 + i, M4, around(b.rand, 30), false)]);
      b.wait(1.5);
    },
  },
  {
    name: 'ambience-rain-yard',
    map: RAILYARD_LIKE,
    script: (b) => {
      b.position = [30, 1.6, 15];
      b.wait(4);
      // Walk past the generator, into the warehouse and out again.
      for (let i = 0; i < 360; i++) {
        b.position = [30 - i * 0.12, 1.6, 15 - i * 0.05];
        b.yaw = i * 0.01;
        b.indoors = b.position[0] <= 0 && b.position[0] >= -20 && b.position[2] <= 10 && b.position[2] >= -10;
        b.step();
      }
      b.indoors = false;
      b.position = [15, 1.6, -25];
      b.step([shot(PLAYER, M4, [15, 1.5, -25.6], true)]);
      b.wait(20);
    },
  },
  {
    name: 'ambience-harbor-oneshots',
    map: HARBOR_LIKE,
    script: (b) => {
      b.wait(10);
      for (let i = 0; i < 600; i++) {
        b.position = [Math.sin(i / 100) * 30, 1.6, Math.cos(i / 100) * 20];
        b.step();
      }
      b.wait(25);
    },
  },
  {
    name: 'reverb-zones',
    map: RAILYARD_LIKE,
    script: (b) => {
      b.wait(1);
      const spots: [Vec, boolean][] = [[[30, 1.6, 15], false], [[-10, 1.6, 0], true], [[15, 1.6, -25], true], [[50, 1.6, 50], false], [[-5, 1.6, 5], true]];
      for (const [pos, indoors] of spots) {
        b.position = pos;
        b.indoors = indoors;
        b.step([shot(PLAYER, M24, [pos[0], 1.5, pos[2] - 0.6], true), shot(8, M4, [pos[0] + 20, 1.5, pos[2]], false)]);
        b.wait(0.3);
      }
      b.indoors = false;
      b.step([{ op: 'reverb', preset: 'forest' }]);
      b.wait(1);
      b.step([shot(PLAYER, M4, [0, 1.5, -0.6], true), { op: 'reverb', preset: 'street' }]);
      b.wait(2);
    },
  },
  {
    name: 'pause-resume',
    map: HARBOR_LIKE,
    script: (b) => {
      b.wait(2);
      b.step([shot(PLAYER, M4, [0, 1.5, -0.6], true), shot(5, M4, [20, 1.5, -20], false)]);
      b.wait(0.05);
      b.step([{ op: 'pause', paused: true }]);
      b.step([shot(5, M4, [20, 1.5, -20], false), { op: 'play', id: 'snd-ui-hit' }, { op: 'play', id: 'snd-equip-2' }]);
      b.wait(1.2);
      b.step([{ op: 'pause', paused: false }]);
      b.wait(0.2);
      b.step([shot(5, M4, [20, 1.5, -20], false)]);
      b.wait(1.5);
    },
  },
  {
    name: 'settings-changes',
    map: FOREST_LIKE,
    script: (b) => {
      b.wait(2);
      b.settings({ ...DEFAULT_SETTINGS, master: 0.4, effects: 0.6 });
      b.step([shot(PLAYER, MP5, [0, 1.5, -0.6], true)]);
      b.wait(0.5);
      b.settings({ ...DEFAULT_SETTINGS, ambience: 0, interface: 1 });
      b.step([{ op: 'play', id: 'snd-ui-kill' }]);
      b.wait(0.5);
      b.settings({ master: 1, effects: 1, ambience: 1, interface: 1, hrtf: false, showHitMarkers: true });
      b.step();
      b.wait(1);
    },
  },
  {
    name: 'public-api',
    script: (b) => {
      b.wait(0.1);
      b.step([
        { op: 'play', id: 'snd-ui-hit', options: { volume: 0.5 } },
        { op: 'play', id: 'snd-equip-1', options: { pitch: 1.2, pitchJitter: 0.1 } },
        { op: 'play', id: 'snd-not-a-sound' },
        { op: 'playAt', id: 'snd-loop-generator', position: [5, 1, -5], options: { loop: true, refDistance: 3, maxDistance: 40 }, handle: 'gen' },
        { op: 'playAt', id: 'snd-ricochet-2', position: [12, 1, -3], options: { volume: 0.8 } },
        { op: 'playAt', id: 'snd-ricochet-3', position: [80, 1, -3] },
      ]);
      b.wait(1);
      // Not decoded on this map until the first request warmed it: this one plays.
      b.step([{ op: 'playAt', id: 'snd-loop-generator', position: [5, 1, -5], options: { loop: true, refDistance: 3, maxDistance: 40 }, handle: 'gen' }]);
      b.wait(0.5);
      b.step([{ op: 'handleVolume', handle: 'gen', volume: 0.3 }]);
      for (let i = 0; i < 90; i++) {
        b.position = [i * 0.4, 1.6, 0];
        b.step();
      }
      b.step([{ op: 'handleStop', handle: 'gen', fade: 0.5 }]);
      b.wait(1);
      b.step([{ op: 'handleStop', handle: 'gen' }, { op: 'handleVolume', handle: 'gen', volume: 1 }]);
      b.wait(0.5);
    },
  },
  {
    name: 'leave-and-reenter-firefight',
    map: RAILYARD_LIKE,
    combatants: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(100 + i), { position: [Math.cos(i) * 40, 0, Math.sin(i) * 40], crouching: i % 3 === 0 }])),
    script: (b) => {
      b.wait(2);
      for (let f = 0; f < 240; f++) {
        const actions: Action[] = [];
        if (b.rand() < 0.5) {
          const id = 100 + Math.floor(b.rand() * 16);
          const w = [M4, SCAR, M7, MP5, unknownWeapon('lmg'), unknownWeapon('sniper')][id % 6]!;
          actions.push(shot(id, w, [Math.cos(id) * 40, 1.5, Math.sin(id) * 40], false));
        }
        if (b.rand() < 0.3) actions.push(ev('footstep', { ownerId: 100 + (f % 16), position: [Math.cos(f) * 40, 0, Math.sin(f) * 40], surface: SURFACES[f % 14], running: f % 2 === 0, local: false }));
        if (f % 20 === 0) actions.push(shot(PLAYER, SCAR, [0, 1.5, -0.6], true));
        if (f === 120) actions.push(ev('grenadeExploded', { ownerId: 101, position: [10, 0, -10], local: false }));
        b.step(actions);
      }
      b.step([{ op: 'leaveMap' }]);
      b.wait(1);
      b.step([{ op: 'enterMap', map: 'harbor' }]);
      b.wait(3);
      b.step([shot(PLAYER, M4, [0, 1.5, -0.6], true)]);
      b.wait(2);
    },
  },
];

export const MAPS: Readonly<Record<string, SceneMap>> = { open: OPEN, railyard: RAILYARD_LIKE, harbor: HARBOR_LIKE, forest: FOREST_LIKE };

export function buildScenes(): Scene[] {
  return SPECS.map((spec, index) => {
    const seed = 1000 + index * 7919;
    const b = new Builder(seed);
    spec.script(b);
    return {
      name: spec.name,
      seed,
      playerId: PLAYER,
      map: spec.map ?? OPEN,
      occluders: spec.occluders ?? [],
      settings: spec.settings ?? DEFAULT_SETTINGS,
      combatants: spec.combatants ?? {},
      frames: b.frames,
    };
  });
}
