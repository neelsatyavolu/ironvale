/**
 * PlayerController scripted-input fixtures (PLAN.md 5.4 layer 1, M4). A seeded generator writes an
 * input script; the real src/player/controller.ts runs it against a CollisionWorld and records the
 * body and camera after every frame. IronvaleSimTests replays the same script on the Swift port and
 * must agree within 1e-5 m.
 *
 * Frame record: [px, py, pz, vx, vy, vz, yaw, pitch, onGround, crouching, sprinting, indoors,
 *                camX, camY, camZ, camRotX, camRotY, camRotZ, fov]
 */
import { Box3, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { EventBus } from '../../../src/core/events';
import { hashString, seededRandom } from '../../../src/core/random';
import { CONTROL_PRESETS } from '../../../src/core/settings';
import type { GameEvents } from '../../../src/game/contracts';
import { PlayerController } from '../../../src/player/controller';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import type { CollisionWorld } from '../../../src/world/collision';
import type { InteriorZone } from '../../../src/world/types';

type Action = 'moveForward' | 'moveBack' | 'moveLeft' | 'moveRight' | 'sprint' | 'crouch' | 'jump';

export interface ScriptFrame {
  readonly dt: number;
  readonly held: Action[];
  readonly pressed: Action[];
  readonly look: [number, number];
  /** setWeaponModifiers before this frame's update. */
  readonly mods?: { mobility: number; aimBlend: number; zoom: number; blockSprint: boolean };
}

export interface PlayerScript {
  readonly name: string;
  readonly preset: 'mouse' | 'trackpad';
  readonly start: { position: number[]; yaw: number };
  readonly frames: ScriptFrame[];
}

export interface PlayerTrace extends PlayerScript {
  readonly records: number[][];
  /** Events emitted during each frame, by name, in order. */
  readonly events: string[][];
}

const DTS = [1 / 60, 1 / 120, 1 / 144, 1 / 30, 0.05, 1 / 90];
const MOVES: Action[][] = [
  ['moveForward'],
  ['moveForward', 'moveLeft'],
  ['moveForward', 'moveRight'],
  ['moveBack'],
  ['moveLeft'],
  ['moveRight'],
  [],
  ['moveForward', 'moveBack'],
];

export function makeScript(seedText: string, start: { position: number[]; yaw: number }, frames: number, preset: 'mouse' | 'trackpad'): PlayerScript {
  const random = seededRandom(hashString(seedText));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const defs = Object.values(WEAPON_DEFS);
  const out: ScriptFrame[] = [];
  while (out.length < frames) {
    const length = 15 + Math.floor(random() * 45);
    const dt = pick(DTS);
    const held: Action[] = [...pick(MOVES)];
    if (random() < 0.35) held.push('sprint');
    if (random() < 0.2) held.push('crouch');
    const jump = random() < 0.35;
    const jumpEvery = 8 + Math.floor(random() * 30);
    const lookX = (random() * 2 - 1) * 30;
    const lookY = (random() * 2 - 1) * 8;
    const def = pick(defs);
    const aimBlend = pick([0, 0, 0.2, 0.5, 1]);
    const mods = { mobility: def.mobility, aimBlend, zoom: def.aimZoom, blockSprint: random() < 0.15 };
    for (let i = 0; i < length && out.length < frames; i++) {
      out.push({
        dt,
        held,
        pressed: jump && i % jumpEvery === 0 ? ['jump'] : [],
        look: [lookX, lookY],
        ...(i === 0 ? { mods } : {}),
      });
    }
  }
  return { name: seedText, preset, start, frames: out };
}

export function runScript(world: CollisionWorld, interiors: readonly { min: number[]; max: number[] }[], script: PlayerScript): PlayerTrace {
  const camera = new PerspectiveCamera();
  let fov = 0;
  const engine = { camera, setFov: (value: number) => (fov = value) };
  let frame: ScriptFrame | null = null;
  const input = {
    isDown: (action: string) => frame?.held.includes(action as Action) ?? false,
    wasPressed: (action: string) => frame?.pressed.includes(action as Action) ?? false,
    consumeLook: () => ({ dx: frame?.look[0] ?? 0, dy: frame?.look[1] ?? 0 }),
    locked: true,
  };
  const settings = { value: { controls: CONTROL_PRESETS[script.preset], gameplay: { fov: 78, headBob: 1 } } };
  const events = new EventBus<GameEvents>();
  const frameEvents: string[] = [];
  for (const name of ['jumped', 'landed', 'footstep', 'spawned'] as const) events.on(name, () => frameEvents.push(name));
  const zones: InteriorZone[] = interiors.map((zone) => ({
    box: new Box3(new Vector3(...zone.min), new Vector3(...zone.max)),
    reverb: 'interior',
  })) as unknown as InteriorZone[];
  const player = new PlayerController({
    engine,
    input,
    settings,
    events,
    world,
    id: 1,
    team: 'alpha',
    interiors: () => zones,
  } as unknown as ConstructorParameters<typeof PlayerController>[0]);

  const start = script.start.position;
  player.respawn(new Vector3(start[0], start[1], start[2]), script.start.yaw);
  frameEvents.length = 0;
  const records: number[][] = [];
  const allEvents: string[][] = [];
  for (const step of script.frames) {
    frame = step;
    if (step.mods) player.setWeaponModifiers(step.mods);
    player.update(step.dt);
    const p = player.position;
    const v = player.velocity;
    records.push([
      p.x,
      p.y,
      p.z,
      v.x,
      v.y,
      v.z,
      player.yaw,
      player.pitch,
      Number(player.onGround),
      Number(player.crouching),
      Number(player.sprinting),
      Number(player.indoors),
      camera.position.x,
      camera.position.y,
      camera.position.z,
      camera.rotation.x,
      camera.rotation.y,
      camera.rotation.z,
      fov,
    ]);
    allEvents.push([...frameEvents]);
    frameEvents.length = 0;
  }
  return { ...script, records, events: allEvents };
}
