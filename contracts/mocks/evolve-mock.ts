// In-memory mock of the Evolve service (Part B) so the runtime (Part A) can
// develop and test without the real service. Part B owns the real endpoints.

import type { EvidenceTurn, Repair, RepairOverlay } from "../types.ts";

export class EvolveMock {
  private evidence = new Map<string, EvidenceTurn>();
  private overlays = new Map<string, RepairOverlay>();

  /** POST /api/evidence/turn — idempotent by tenant:session:turn:utterance. */
  receiveEvidence(turn: EvidenceTurn): { accepted: boolean; duplicate: boolean } {
    const key = `${turn.tenant}:${turn.session_id}:${turn.turn_id}:${turn.utterance_id}`;
    const duplicate = this.evidence.has(key);
    if (!duplicate) this.evidence.set(key, turn);
    return { accepted: true, duplicate };
  }

  /** GET /api/session/{id}/repairs */
  getRepairs(sessionId: string): RepairOverlay {
    return (
      this.overlays.get(sessionId) ?? {
        session_id: sessionId,
        overlay_version: 0,
        repairs: [],
      }
    );
  }

  /** Test helper: simulate Evolve releasing a repair for a session. */
  releaseRepair(sessionId: string, repair: Repair): RepairOverlay {
    const current = this.getRepairs(sessionId);
    const next: RepairOverlay = {
      session_id: sessionId,
      overlay_version: current.overlay_version + 1,
      repairs: [...current.repairs, repair],
    };
    this.overlays.set(sessionId, next);
    return next;
  }

  evidenceCount(): number {
    return this.evidence.size;
  }

  allEvidence(): EvidenceTurn[] {
    return [...this.evidence.values()];
  }
}
