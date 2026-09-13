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
  /**
   * Ordering group. Jobs sharing a stream run strictly in enqueue order; jobs
   * in different streams run concurrently.
   *
   * This is not a nicety. Two writes to the SAME record are order-dependent:
   *
   *   Sentry — resolve-then-reopen and reopen-then-resolve leave the issue in
   *   opposite states. Racing them makes the final status depend on which HTTP
   *   call happens to return first, so a rolled-back repair can be left showing
   *   as resolved.
   *
   *   Slack — replies need the thread_ts that opening the thread returns. If a
   *   finding wins the race it posts as a top-level message instead of a reply,
   *   and the incident thread silently comes apart.
   *
   * Jobs with no stream keep the old fully-concurrent behaviour.
   */
  stream?: string;
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
  /** Tail promise per ordering stream; see AppJob.stream. */
  private streams = new Map<string, Promise<void>>();

  constructor(
    private readonly maxAttempts = 4,
    /** Injected so tests do not actually sleep. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    /**
     * Base backoff. Retries here wait on EXTERNAL eventual consistency, not on
     * a flaky socket: a Sentry issue took well over ten seconds to become
     * searchable after its event was accepted. A few hundred milliseconds of
     * backoff would exhaust every attempt before the record could possibly
     * exist, and report a permanent failure for something that simply had not
     * appeared yet.
     */
    private readonly backoffMs = 4000,
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

    if (job.stream) {
      // Chain onto this stream's tail so the job starts only after the
      // previous one in the same stream has settled. The tail never rejects
      // (execute swallows), so the chain cannot break.
      const previous = this.streams.get(job.stream) ?? Promise.resolve();
      const next = previous.then(() => this.execute(job));
      this.streams.set(job.stream, next);
      this.pending.push(next);
      return;
    }

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
        if (attempt < this.maxAttempts) await this.sleep(attempt * this.backoffMs);
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
