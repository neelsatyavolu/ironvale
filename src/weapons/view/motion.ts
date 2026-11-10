/** Small numeric helpers for procedural view-model motion. */

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** 0 before `from`, 1 after `to`, eased in between. */
export function ramp(from: number, to: number, time: number): number {
  if (to <= from) return time >= to ? 1 : 0;
  return smoothstep((time - from) / (to - from));
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Longest step the springs are integrated with; longer frames are split. */
const MAX_SPRING_STEP = 1 / 120;

/** Damped spring toward zero (or a target), driven by impulses. */
export class Spring {
  value = 0;
  velocity = 0;

  constructor(
    private readonly stiffness: number,
    private readonly damping: number,
  ) {}

  kick(impulse: number): void {
    this.velocity += impulse;
  }

  step(dt: number, target = 0): number {
    let remaining = dt;
    while (remaining > 1e-6) {
      const h = Math.min(remaining, MAX_SPRING_STEP);
      this.velocity += ((target - this.value) * this.stiffness - this.velocity * this.damping) * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.velocity = 0;
  }
}
