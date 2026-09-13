// Injected time and identity.
//
// Nothing in the domain calls Date.now() directly. Incident ids, artifact
// timestamps and latency measurements all flow from here, so a test can replay
// the entire loop deterministically and the eval suite can report real elapsed
// time without the two getting confused.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Advances by a fixed step on each read, so ordering is stable across runs. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start = 1_760_000_000_000, private readonly stepMs = 1000) {
    this.t = start;
  }
  now(): number {
    const v = this.t;
    this.t += this.stepMs;
    return v;
  }
  /** Read without advancing. */
  peek(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
