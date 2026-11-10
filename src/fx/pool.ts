/** Ring allocator: hands out slots in order and recycles the oldest once every slot is in use. */
export class RingPool {
  private cursor = 0;
  private used = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`RingPool needs a positive capacity, got ${capacity}`);
  }

  /** true once every slot has been handed out at least once. */
  get wrapped(): boolean {
    return this.used >= this.capacity;
  }

  /** Take the next slot. When the pool is full this is the oldest one. */
  next(): number {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    return slot;
  }

  /** The slot that will be handed out `ahead` allocations from now. */
  peek(ahead = 0): number {
    return (this.cursor + ahead) % this.capacity;
  }

  reset(): void {
    this.cursor = 0;
    this.used = 0;
  }
}

/** Tracks the span of slots written since the last upload so only that part of a buffer is sent to the GPU. */
export class DirtyRange {
  private min = Infinity;
  private max = -Infinity;

  mark(slot: number): void {
    if (slot < this.min) this.min = slot;
    if (slot > this.max) this.max = slot;
  }

  /** Calls `upload(firstSlot, slotCount)` when anything was marked, then clears. */
  flush(upload: (start: number, count: number) => void): void {
    if (this.max < this.min) return;
    upload(this.min, this.max - this.min + 1);
    this.min = Infinity;
    this.max = -Infinity;
  }
}

/**
 * Particle count for a quality setting. The fractional part becomes a chance,
 * so three particles at half density average 1.5 instead of always rounding.
 * `roll` is a random number in [0, 1).
 */
export function scaledCount(base: number, density: number, roll: number): number {
  const exact = base * Math.max(0, density);
  const whole = Math.floor(exact);
  return whole + (roll < exact - whole ? 1 : 0);
}
