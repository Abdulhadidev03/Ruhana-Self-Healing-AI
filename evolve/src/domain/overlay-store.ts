// Server-side session overlay (plan §10, "Same-call activation without
// inconsistent turns"). This is what GET /api/session/{id}/repairs serves.
//
// One non-obvious constraint drives the whole design: Part A's SessionOverlayStore
// only stages an overlay whose overlay_version is STRICTLY GREATER than the one
// it already holds. That means a rollback cannot be expressed by reverting to an
// earlier version number — the runtime would silently ignore it. A rollback is
// therefore a NEW, HIGHER overlay version with the bad repair removed.

import type { Repair, RepairOverlay } from "../../../contracts/types.ts";
import type { RepairArtifact } from "./model.ts";

export interface OverlayState {
  session_id: string;
  base_version: string;
  overlay_version: number;
  repairs: Repair[];
  /** Artifacts backing each active repair, keyed by repair_id. */
  artifacts: Map<string, RepairArtifact>;
}

export class SessionOverlayRegistry {
  private sessions = new Map<string, OverlayState>();

  constructor(private readonly defaultBaseVersion: string) {}

  private ensure(sessionId: string): OverlayState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        session_id: sessionId,
        base_version: this.defaultBaseVersion,
        overlay_version: 0,
        repairs: [],
        artifacts: new Map(),
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Exactly the payload of contract 2. Unknown sessions get the empty overlay. */
  serve(sessionId: string): RepairOverlay {
    const s = this.sessions.get(sessionId);
    if (!s) return { session_id: sessionId, overlay_version: 0, repairs: [] };
    return {
      session_id: s.session_id,
      overlay_version: s.overlay_version,
      repairs: s.repairs.map((r) => ({ ...r })),
    };
  }

  baseVersion(sessionId: string): string {
    return this.sessions.get(sessionId)?.base_version ?? this.defaultBaseVersion;
  }

  overlayVersion(sessionId: string): number {
    return this.sessions.get(sessionId)?.overlay_version ?? 0;
  }

  /** The version a NEWLY released repair will occupy. */
  nextOverlayVersion(sessionId: string): number {
    return this.overlayVersion(sessionId) + 1;
  }

  activeArtifacts(sessionId: string): RepairArtifact[] {
    const s = this.sessions.get(sessionId);
    return s ? [...s.artifacts.values()] : [];
  }

  /**
   * Publish a released artifact into the session overlay, superseding any
   * earlier repair for the same entity and type.
   */
  release(sessionId: string, artifact: RepairArtifact): RepairOverlay {
    const s = this.ensure(sessionId);
    const repair = artifact.repair;

    // Supersede rather than accumulate: two pronunciation repairs for one entity
    // would leave the runtime resolving the conflict, which is our job.
    const kept = s.repairs.filter(
      (r) => !(r.type === repair.type && r.scope.entity_id === repair.scope.entity_id),
    );

    s.overlay_version += 1;
    s.repairs = [...kept, repair];
    s.artifacts.set(repair.repair_id, artifact);
    return this.serve(sessionId);
  }

  /**
   * Roll a repair back (plan §10 "Rollback conditions").
   *
   * Emits a HIGHER overlay version with the repair removed, because the runtime
   * ignores any overlay that does not advance the counter. Returns null when the
   * repair was not active, so a duplicate rollback is a no-op rather than an
   * empty version bump.
   */
  rollback(sessionId: string, repairId: string): RepairOverlay | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const present = s.repairs.some((r) => r.repair_id === repairId);
    if (!present) return null;

    s.repairs = s.repairs.filter((r) => r.repair_id !== repairId);
    s.overlay_version += 1;
    const artifact = s.artifacts.get(repairId);
    if (artifact) artifact.status = "rolled_back";
    s.artifacts.delete(repairId);
    return this.serve(sessionId);
  }

  /** Sessions currently holding at least one repair, for the dashboard. */
  activeSessions(): string[] {
    return [...this.sessions.values()].filter((s) => s.repairs.length > 0).map((s) => s.session_id);
  }
}
