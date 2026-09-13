// Polls the Repair API (contract 2) and stages overlays into the session store.
// Staging is safe at any moment; activation happens only at turn boundaries.

import type { RepairOverlay } from "../../contracts/types.ts";
import type { SessionOverlayStore } from "./overlay.ts";

export class RepairsClient {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly store: SessionOverlayStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async pollOnce(): Promise<boolean> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/session/${encodeURIComponent(this.sessionId)}/repairs`,
    );
    if (!res.ok) return false;
    const overlay = (await res.json()) as RepairOverlay;
    return this.store.stage(overlay);
  }

  start(intervalMs = 1500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => {});
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
