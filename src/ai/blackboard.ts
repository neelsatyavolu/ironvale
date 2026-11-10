import { Vector3 } from 'three/webgpu';

export type BotState =
  | 'patrol'
  | 'investigate'
  | 'cover'
  | 'strafe'
  | 'push'
  | 'flank'
  | 'suppress'
  | 'fallback'
  | 'hold'
  | 'dead';

export type CalloutKind = 'spotted' | 'reloading' | 'hurt' | 'death';

export interface SquadMember {
  readonly alive: boolean;
  readonly state: BotState;
  /** Cover cell held or being run to, or -1. */
  readonly coverNode: number;
  /** Holds one of the squad's firing turns. */
  readonly firing?: boolean;
}

/** Seconds between two callouts of the same kind from the squad. */
const CALLOUT_GAP: Readonly<Record<CalloutKind, number>> = { spotted: 4, reloading: 3, hurt: 3, death: 0 };
/** A sighting this long after the last one starts a new contact. */
const CONTACT_BREAK = 6;

/**
 * What the squad knows together: where the enemy was last seen, who is
 * holding the front, who is advancing and who has gone round the side.
 * Soldiers read it when choosing what to do, so they do not all rush at once.
 */
export class Squad {
  readonly lastKnown = new Vector3();
  readonly spotterPosition = new Vector3();
  spotterId = -1;
  /** Game time of the latest sighting, and of the first sighting in this contact. */
  contactTime = -Infinity;
  contactStart = -Infinity;
  alive = 0;
  /** Fighting from cover or in the open: the front. */
  engaging = 0;
  pushing = 0;
  flanking = 0;
  /** Soldiers holding a firing turn. */
  firing = 0;
  /** Cover cell of each member, in member order (-1 for none). */
  readonly takenCover: number[] = [];
  private readonly lastCallout: Record<CalloutKind, number> = {
    spotted: -Infinity,
    reloading: -Infinity,
    hurt: -Infinity,
    death: -Infinity,
  };

  tally(members: readonly SquadMember[]): void {
    this.alive = 0;
    this.engaging = 0;
    this.pushing = 0;
    this.flanking = 0;
    this.firing = 0;
    this.takenCover.length = members.length;
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      this.takenCover[i] = member && member.alive ? member.coverNode : -1;
      if (!member || !member.alive) continue;
      this.alive++;
      if (member.firing) this.firing++;
      const state = member.state;
      if (state === 'push') this.pushing++;
      else if (state === 'flank') this.flanking++;
      else if (state === 'cover' || state === 'strafe' || state === 'hold' || state === 'suppress') this.engaging++;
    }
  }

  /** A soldier saw the enemy. */
  report(botId: number, botPosition: Vector3, enemyPosition: Vector3, time: number): void {
    if (time - this.contactTime > CONTACT_BREAK) this.contactStart = time;
    this.contactTime = time;
    this.spotterId = botId;
    this.spotterPosition.copy(botPosition);
    this.lastKnown.copy(enemyPosition);
  }

  hasContact(time: number, maxAge: number): boolean {
    return time - this.contactTime <= maxAge;
  }

  /** May one more soldier advance? At most a share of the squad pushes at a time, and never everyone. */
  canPush(pushFraction: number): boolean {
    const cap = Math.min(Math.max(1, Math.round(this.alive * pushFraction)), Math.max(1, this.alive - 1));
    return this.pushing < cap;
  }

  /** May one more soldier go round the side? Only while at least two mates hold the front. */
  canFlank(): boolean {
    return this.engaging >= 2 && this.flanking < Math.max(1, Math.floor(this.alive / 4));
  }

  /** true when the squad has not made this kind of callout too recently; records it. */
  tryCallout(kind: CalloutKind, time: number): boolean {
    if (time - this.lastCallout[kind] < CALLOUT_GAP[kind]) return false;
    this.lastCallout[kind] = time;
    return true;
  }

  reset(): void {
    this.contactTime = -Infinity;
    this.contactStart = -Infinity;
    this.spotterId = -1;
    this.alive = this.engaging = this.pushing = this.flanking = this.firing = 0;
    this.takenCover.length = 0;
    this.lastCallout.spotted = this.lastCallout.reloading = this.lastCallout.hurt = this.lastCallout.death = -Infinity;
  }
}
