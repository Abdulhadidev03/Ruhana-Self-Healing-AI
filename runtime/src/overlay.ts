// Session repair overlay (plan §10, "Same-call activation without inconsistent turns").
// An immutable base version plus a versioned overlay. Newly released repairs are
// STAGED as they arrive and only become active at a turn boundary, so a turn's
// effective version never changes underneath it.

import type { Repair, RepairOverlay } from "../../contracts/types.ts";
import { verifyWireRepair } from "../../contracts/artifact.ts";

export interface VersionSnapshot {
  effectiveVersion: string;
  overlayVersion: number;
  repairs: readonly Repair[];
}

export class SessionOverlayStore {
  private staged: RepairOverlay | null = null;
  private active: RepairOverlay;

  constructor(
    private readonly baseVersion: string,
    private readonly tenant: string,
    private readonly sessionId: string,
  ) {
    this.active = { session_id: sessionId, overlay_version: 0, repairs: [] };
  }

  /** Called whenever the Repair API returns; may arrive mid-turn. */
  stage(overlay: RepairOverlay): boolean {
    if (overlay.session_id !== this.sessionId) return false;
    if (overlay.overlay_version <= this.active.overlay_version) return false;
    if (this.staged && overlay.overlay_version <= this.staged.overlay_version) return false;
    // Artifact verification (plan §10): an unsigned repair is tolerated for
    // back-compatibility, but a repair whose hash does not verify poisons the
    // whole overlay — the runtime cannot trust a partially valid version.
    for (const repair of overlay.repairs) {
      if (verifyWireRepair(repair, this.baseVersion) === "invalid") return false;
    }
    this.staged = overlay;
    return true;
  }

  /** Called at a turn boundary only. Returns true if the active overlay advanced. */
  applyAtTurnBoundary(): boolean {
    if (!this.staged) return false;
    this.active = this.staged;
    this.staged = null;
    return true;
  }

  /** Frozen view a turn pins itself to. */
  snapshot(): VersionSnapshot {
    return {
      effectiveVersion: `${this.baseVersion}+overlay.${this.active.overlay_version}`,
      overlayVersion: this.active.overlay_version,
      repairs: Object.freeze([...this.active.repairs]),
    };
  }

  /**
   * Scope enforcement (plan §6A): a repair applies only when its tenant matches,
   * its entity matches, and — if session-scoped — the session matches.
   */
  repairsForEntity(snapshot: VersionSnapshot, entityId: string): Repair[] {
    return snapshot.repairs.filter(
      (r) =>
        r.scope.tenant === this.tenant &&
        r.scope.entity_id === entityId &&
        (r.scope.session_id === undefined || r.scope.session_id === this.sessionId),
    );
  }
}
