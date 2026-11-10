import { Vector3 } from 'three/webgpu';
import type { World } from '../world/types';
import type { Combatant, CombatRegistry, ShotResult, Team } from './contracts';

/** Tracks every combatant and resolves bullets against the world and bodies. */
export class Combat implements CombatRegistry {
  private readonly combatants = new Map<number, Combatant>();
  private nextId = 1;
  /** Reused result lists, one per asking team, so per-frame callers do not allocate. */
  private readonly enemyLists: Record<Team, Combatant[]> = { alpha: [], bravo: [] };

  constructor(private readonly world: () => World) {}

  allocateId(): number {
    return this.nextId++;
  }

  add(combatant: Combatant): void {
    this.combatants.set(combatant.id, combatant);
  }

  remove(id: number): void {
    this.combatants.delete(id);
  }

  get(id: number): Combatant | undefined {
    return this.combatants.get(id);
  }

  all(): readonly Combatant[] {
    return [...this.combatants.values()];
  }

  enemiesOf(team: Team): readonly Combatant[] {
    const list = this.enemyLists[team];
    list.length = 0;
    for (const combatant of this.combatants.values()) {
      if (combatant.alive && combatant.team !== team) list.push(combatant);
    }
    return list;
  }

  clear(): void {
    this.combatants.clear();
  }

  raycast(origin: Vector3, direction: Vector3, maxDistance: number, ignoreId: number, ignoreTeam?: Team): ShotResult {
    const worldHit = this.world().raycast(origin, direction, maxDistance);
    let limit = worldHit ? worldHit.distance : maxDistance;
    let struck: Combatant | null = null;
    let struckHit: ShotResult['combatantHit'] = null;
    for (const combatant of this.combatants.values()) {
      if (!combatant.alive || combatant.id === ignoreId || combatant.team === ignoreTeam) continue;
      const hit = combatant.hitTest(origin, direction, limit);
      if (!hit) continue;
      limit = hit.distance;
      struck = combatant;
      struckHit = hit;
    }
    return {
      world: struck ? null : worldHit,
      combatant: struck,
      combatantHit: struckHit,
      end: new Vector3().copy(origin).addScaledVector(direction, limit),
      distance: limit,
    };
  }
}
