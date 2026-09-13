// Durable-ish job ledger for external app writes (plan §11).
//
// Three properties the plan asks for, in order of importance:
//
//   1. Asynchronous — "Normal conversation does not wait for Sentry, GitHub, or
//      Slack" (§5). enqueue() returns immediately.
//   2. Idempotent by incident/version key — a retry after a timeout must update
//      one record, not create a second.
//   3. Non-blocking on failure — "A Slack failure does not prevent an already
//      verified session correction" (§11). A dead connector degrades the audit
//      trail, never the repair.

export interface AppJob {
  /** Idempotency key. Same key = same job, however many times it is enqueued. */
  key: string;
  app: "sentry" | "slack" | "github";
  description: string;
  run: () => Promise<unknown>;
}

export interface JobOutcome {
  key: string;
  app: AppJob["app"];
  description: string;
  status: "ok" | "failed" | "skipped_duplicate";
  attempts: number;
  error: string | null;
  result: unknown;
}

export class AppWriteQueue {
  private seen = new Set<string>();
  private pending: Promise<void>[] = [];
  private outcomes: JobOutcome[] = [];

  constructor(
    private readonly maxAttempts = 3,
    /** Injected so tests do not actually sleep. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Fire-and-forget. Never throws into the repair loop. */
  enqueue(job: AppJob): void {
    if (this.seen.has(job.key)) {
      this.outcomes.push({
        key: job.key,
        app: job.app,
        description: job.description,
        status: "skipped_duplicate",
        attempts: 0,
        error: null,
        result: null,
      });
      return;
    }
    this.seen.add(job.key);
    this.pending.push(this.execute(job));
  }

  private async execute(job: AppJob): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const result = await job.run();
        this.outcomes.push({
          key: job.key,
          app: job.app,
          description: job.description,
          status: "ok",
          attempts: attempt,
          error: null,
          result,
        });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < this.maxAttempts) await this.sleep(attempt * 100);
      }
    }
    this.outcomes.push({
      key: job.key,
      app: job.app,
      description: job.description,
      status: "failed",
      attempts: this.maxAttempts,
      error: String(lastError),
      result: null,
    });
  }

  /** Await every queued write. Used by the demo, the eval run, and tests. */
  async drain(): Promise<JobOutcome[]> {
    while (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
    }
    return [...this.outcomes];
  }

  results(): JobOutcome[] {
    return [...this.outcomes];
  }
}
