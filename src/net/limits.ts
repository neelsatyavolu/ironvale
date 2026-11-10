/**
 * Limits on what the other player's messages may do. This is a game between
 * two friends, not a competitive service: the aim is that a broken or
 * tampered client cannot do anything a real weapon could not.
 */
import type { WeaponDef } from '../game/contracts';

export const NAME_LENGTH = 16;
const NAME_DROP = /[^\p{L}\p{N} _.'-]/gu;

/** A display name: letters, digits, spaces and a little punctuation, at most 16 characters. */
export function sanitizeName(raw: unknown, fallback = 'Player'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(NAME_DROP, '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH).trim();
  return cleaned === '' ? fallback : cleaned;
}

/** The most one projectile of this weapon can do: a headshot inside full-damage range. */
export function maxHitDamage(def: Pick<WeaponDef, 'damage' | 'headshotMultiplier'>): number {
  return def.damage * Math.max(1, def.headshotMultiplier);
}

/** Damage a reported hit is allowed to do. Anything that is not a positive number does none. */
export function capDamage(def: Pick<WeaponDef, 'damage' | 'headshotMultiplier'>, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(amount, maxHitDamage(def));
}

/** Classic token bucket on a millisecond clock. */
export class TokenBucket {
  private tokens: number;
  private at = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly perSecond: number,
    private readonly size: number,
  ) {
    this.tokens = size;
  }

  take(now: number, count = 1): boolean {
    if (now > this.at) {
      if (this.at !== Number.NEGATIVE_INFINITY) {
        this.tokens = Math.min(this.size, this.tokens + ((now - this.at) / 1000) * this.perSecond);
      }
      this.at = now;
    }
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}

/** Slack over the nominal rate: frame timing and the network bunch shots together. */
const RATE_SLACK = 1.25;
/** Seconds of fire that may arrive at once after a stall on the reliable channel. */
const BURST_SECONDS = 0.75;

/**
 * Holds one sender to each weapon's rate of fire, for shots and for the hits
 * they report (a shotgun reports one hit per pellet).
 */
export class WeaponGate {
  private readonly shots = new Map<string, TokenBucket>();
  private readonly hits = new Map<string, TokenBucket>();

  allowShot(def: WeaponDef, now: number): boolean {
    return this.bucket(this.shots, def, 1).take(now);
  }

  allowHit(def: WeaponDef, now: number): boolean {
    return this.bucket(this.hits, def, Math.max(1, def.pellets)).take(now);
  }

  private bucket(map: Map<string, TokenBucket>, def: WeaponDef, perShot: number): TokenBucket {
    const existing = map.get(def.id);
    if (existing) return existing;
    const perSecond = (def.roundsPerMinute / 60) * RATE_SLACK * perShot;
    const size = Math.max(2, Math.ceil(perSecond * BURST_SECONDS), perShot);
    const created = new TokenBucket(perSecond, size);
    map.set(def.id, created);
    return created;
  }
}
