// Immutable repair artifacts (plan §10).
//
// "The gate issues a hashed or signed repair artifact. Signing proves integrity
// and issuer identity, not correctness." The hash here is exactly that and
// nothing more — it is not evidence that the repair works.
//
// Note on the wire contract: contracts/types.ts (owned jointly with Part A) does
// not carry artifact_hash on Repair. Rather than edit the frozen contract
// mid-build, the artifact is held here and exposed through Evolve's dashboard
// API. Adding an optional field to the wire Repair is an integration-time
// decision for both sides, recorded in INTEGRATION.md.

import type { Repair } from "../../../contracts/types.ts";
import type { RepairArtifact } from "./model.ts";
import { artifactBody, hashRepair } from "../../../contracts/artifact.ts";

export { artifactBody, hashRepair };

export const ISSUER = "ruhana-evolve/gate@v1";

export function issueArtifact(params: {
  repair: Repair;
  incidentId: string;
  baseVersion: string;
  overlayVersion: number;
  issuedAt: number;
}): RepairArtifact {
  const hash = hashRepair(params.repair, params.baseVersion, params.overlayVersion);
  return {
    repair_id: params.repair.repair_id,
    incident_id: params.incidentId,
    repair: params.repair,
    artifact_hash: hash,
    issuer: ISSUER,
    issued_at: params.issuedAt,
    overlay_version: params.overlayVersion,
    base_version: params.baseVersion,
    status: "active",
  };
}

/**
 * Verify an artifact's integrity. The runtime performs the equivalent check
 * before trusting a repair (plan §10: "The runtime checks the artifact and pins
 * the effective version for each utterance").
 */
export function verifyArtifact(artifact: RepairArtifact): boolean {
  return (
    artifact.artifact_hash ===
    hashRepair(artifact.repair, artifact.base_version, artifact.overlay_version)
  );
}
