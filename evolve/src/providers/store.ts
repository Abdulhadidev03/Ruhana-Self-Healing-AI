// Evidence and incident store (plan §11: "Version registry and durable job
// ledger").
//
// The in-memory implementation is the reference. A Supabase-backed one slots in
// behind the same interface once the separate Evolve project exists — note the
// plan requires a SEPARATE data namespace from the product database (§15), so
// this deliberately does not reuse the runtime's Supabase credentials.

import type { EvidenceTurn } from "../../../contracts/types.ts";
import type { EvidenceRecord, Incident, RepairArtifact } from "../domain/model.ts";
import { evidenceId } from "../domain/ids.ts";

export interface EvolveStore {
  /** Idempotent by Part A's key: tenant:session:turn:utterance. */
  putEvidence(turn: EvidenceTurn, receivedAt: number): { record: EvidenceRecord; duplicate: boolean };
  getEvidence(id: string): EvidenceRecord | null;
  knownEvidenceIds(): string[];
  evidenceForSession(sessionId: string): EvidenceRecord[];

  /** Idempotent by incident id, which is derived from the failure (see ids.ts). */
  upsertIncident(incident: Incident): { incident: Incident; created: boolean };
  getIncident(id: string): Incident | null;
  listIncidents(): Incident[];
  updateIncident(id: string, patch: Partial<Incident>): Incident | null;

  putArtifact(artifact: RepairArtifact): void;
  getArtifact(repairId: string): RepairArtifact | null;
  knownRepairIds(): string[];
  listArtifacts(): RepairArtifact[];
}

export class InMemoryStore implements EvolveStore {
  private evidence = new Map<string, EvidenceRecord>();
  private incidents = new Map<string, Incident>();
  private artifacts = new Map<string, RepairArtifact>();

  putEvidence(turn: EvidenceTurn, receivedAt: number): { record: EvidenceRecord; duplicate: boolean } {
    const id = evidenceId(turn.tenant, turn.session_id, turn.turn_id, turn.utterance_id);
    const existing = this.evidence.get(id);
    if (existing) return { record: existing, duplicate: true };
    const record: EvidenceRecord = { evidence_id: id, turn, received_at: receivedAt };
    this.evidence.set(id, record);
    return { record, duplicate: false };
  }

  getEvidence(id: string): EvidenceRecord | null {
    return this.evidence.get(id) ?? null;
  }

  knownEvidenceIds(): string[] {
    return [...this.evidence.keys()];
  }

  evidenceForSession(sessionId: string): EvidenceRecord[] {
    return [...this.evidence.values()]
      .filter((r) => r.turn.session_id === sessionId)
      .sort((a, b) => a.received_at - b.received_at);
  }

  upsertIncident(incident: Incident): { incident: Incident; created: boolean } {
    const existing = this.incidents.get(incident.incident_id);
    if (existing) {
      // Duplicate detection of the same failure: fold the new evidence in
      // rather than opening a second incident (plan §14).
      const merged: Incident = {
        ...existing,
        evidence_ids: [...new Set([...existing.evidence_ids, ...incident.evidence_ids])],
      };
      this.incidents.set(merged.incident_id, merged);
      return { incident: merged, created: false };
    }
    this.incidents.set(incident.incident_id, incident);
    return { incident, created: true };
  }

  getIncident(id: string): Incident | null {
    return this.incidents.get(id) ?? null;
  }

  listIncidents(): Incident[] {
    return [...this.incidents.values()].sort((a, b) => a.opened_at - b.opened_at);
  }

  updateIncident(id: string, patch: Partial<Incident>): Incident | null {
    const existing = this.incidents.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, incident_id: existing.incident_id };
    this.incidents.set(id, updated);
    return updated;
  }

  putArtifact(artifact: RepairArtifact): void {
    this.artifacts.set(artifact.repair_id, artifact);
  }

  getArtifact(repairId: string): RepairArtifact | null {
    return this.artifacts.get(repairId) ?? null;
  }

  knownRepairIds(): string[] {
    return [...this.artifacts.keys()];
  }

  listArtifacts(): RepairArtifact[] {
    return [...this.artifacts.values()].sort((a, b) => a.issued_at - b.issued_at);
  }
}
