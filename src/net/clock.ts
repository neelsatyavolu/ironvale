/**
 * Estimates how far the other player's clock is from ours, from pings.
 *
 * Each ping gives a round-trip time and, assuming the two legs took equally
 * long, an offset. Of the recent pings the one with the quickest round trip
 * had the least queueing, so its offset is the one to trust.
 */

interface Sample {
  readonly rtt: number;
  readonly offset: number;
}

const WINDOW = 10;
const MAX_RTT_MS = 10_000;
const RTT_SMOOTHING = 0.2;

export class ClockSync {
  private samples: readonly Sample[] = [];
  private best: Sample | null = null;
  private smoothedRtt = -1;

  get synced(): boolean {
    return this.best !== null;
  }

  /** Remote clock minus local clock, milliseconds. 0 until the first ping returns. */
  get offset(): number {
    return this.best?.offset ?? 0;
  }

  /** Smoothed round-trip time in milliseconds, or -1 before the first ping returns. */
  get rtt(): number {
    return this.smoothedRtt;
  }

  /**
   * @param sentAt local time the ping left
   * @param remoteTime the other side's clock when it answered
   * @param receivedAt local time the answer arrived
   */
  addSample(sentAt: number, remoteTime: number, receivedAt: number): void {
    const rtt = receivedAt - sentAt;
    if (!Number.isFinite(rtt) || !Number.isFinite(remoteTime) || rtt < 0 || rtt > MAX_RTT_MS) return;
    const sample: Sample = { rtt, offset: remoteTime - (sentAt + rtt / 2) };
    this.samples = [...this.samples, sample].slice(-WINDOW);
    this.best = this.samples.reduce((quickest, entry) => (entry.rtt <= quickest.rtt ? entry : quickest));
    this.smoothedRtt = this.smoothedRtt < 0 ? rtt : this.smoothedRtt + (rtt - this.smoothedRtt) * RTT_SMOOTHING;
  }

  toLocal(remoteTime: number): number {
    return remoteTime - this.offset;
  }

  toRemote(localTime: number): number {
    return localTime + this.offset;
  }

  reset(): void {
    this.samples = [];
    this.best = null;
    this.smoothedRtt = -1;
  }
}
