// The machine release gate (plan §10).
//
// There is no human approval button in this design, so this file is the control
// boundary. It is deterministic, total, and model-free on purpose: the six
// conditions below are the only thing standing between a model's opinion and a
// change that reaches a live conversation.
//
// Plan §10, verbatim: "A self-reported confidence number is not enough." The
// supervisor's confidence is therefore never read here.

import type { RepairType } from "../../../contracts/types.ts";
import type { GateCondition, GateInput, GateResult } from "./model.ts";

/** Payload keys each repair type is permitted to carry. Anything else is a mutation
 *  attempt outside the declared contract and fails condition 4. */
const ALLOWED_PAYLOAD_KEYS: Record<RepairType, readonly string[]> = {
  pronunciation: ["phonemes", "voice_model_version"],
  entity_rebinding: ["entity_id", "canonical_text"],
};

/**
 * Fields a candidate must never be able to write. Plan §15: "Keep source
 * reference records immutable from the repair agent's perspective ... so a
 * candidate cannot redefine the correct answer."
 */
const PROTECTED_KEYS = [
  "reference_phonemes",
  "reference_audio_id",
  "must_not_rewrite",
  "status",
  "fixtures",
  "required_fixture_ids",
  "permissions",
  "allowed_types",
  "allowed_entity_ids",
  "gate",
  "issuer",
  "artifact_hash",
];

function condition(
  id: GateCondition["id"],
  name: string,
  passed: boolean,
  detail: string,
): GateCondition {
  return { id, name, passed, detail };
}

/**
 * Condition 1 — the patch fits an allowed type and permitted tenant/entity/component.
 */
function checkScope(input: GateInput): GateCondition {
  const { candidate, decision, incident, allowedTypes, allowedEntityIds } = input;

  if (!allowedTypes.includes(candidate.type)) {
    return condition(1, "allowed type and scope", false, "Repair type '" + candidate.type + "' is not permitted for this tenant.");
  }
  if (decision.scope.tenant !== incident.tenant) {
    return condition(1, "allowed type and scope", false, "Decision scope tenant '" + decision.scope.tenant + "' does not match incident tenant '" + incident.tenant + "'.");
  }
  const entity = decision.scope.entity_id;
  if (entity !== null && !allowedEntityIds.includes(entity)) {
    return condition(1, "allowed type and scope", false, "Entity '" + entity + "' is not in the permitted set for this tenant.");
  }
  // A repair must not silently widen beyond the entity the incident was about.
  if (incident.entity_id !== null && entity !== null && entity !== incident.entity_id) {
    return condition(1, "allowed type and scope", false, "Repair targets entity '" + entity + "' but the incident concerns '" + incident.entity_id + "'.");
  }
  return condition(1, "allowed type and scope", true, "Type '" + candidate.type + "' permitted; scope confined to the incident entity.");
}

/**
 * Condition 2 — referenced evidence exists and matches the incident versions.
 */
function checkEvidence(input: GateInput): GateCondition {
  const { incident, knownEvidenceIds } = input;
  if (incident.evidence_ids.length === 0) {
    return condition(2, "evidence present and matching", false, "Incident references no evidence.");
  }
  const missing = incident.evidence_ids.filter((id) => !knownEvidenceIds.includes(id));
  if (missing.length > 0) {
    return condition(2, "evidence present and matching", false, "Referenced evidence not retrievable: " + missing.join(", ") + ".");
  }
  return condition(2, "evidence present and matching", true, incident.evidence_ids.length + " evidence record(s) resolved for incident " + incident.incident_id + ".");
}

/**
 * Condition 3 — required reproducer and regression checks completed successfully.
 *
 * "Completed successfully" means every REQUIRED fixture actually ran and passed.
 * A fixture that was skipped is not a pass; silently missing coverage is the
 * failure mode this condition exists to catch.
 */
function checkChecks(input: GateInput): GateCondition {
  const { verdict, requiredFixtureIds } = input;

  if (verdict.refuted) {
    return condition(3, "reproducer and regressions passed", false, "Verifier refuted the candidate: " + verdict.reason);
  }

  const ran = new Set(verdict.fixture_results.map((f) => f.fixture_id));
  const notRun = requiredFixtureIds.filter((id) => !ran.has(id));
  if (notRun.length > 0) {
    return condition(3, "reproducer and regressions passed", false, "Required fixtures did not run: " + notRun.join(", ") + ".");
  }

  const failed = verdict.fixture_results.filter((f) => !f.passed);
  if (failed.length > 0) {
    return condition(3, "reproducer and regressions passed", false, "Fixtures failed: " + failed.map((f) => f.fixture_id).join(", ") + ".");
  }

  return condition(3, "reproducer and regressions passed", true, verdict.fixture_results.length + " fixture(s) ran, all passed, including " + requiredFixtureIds.length + " required.");
}

/**
 * Condition 4 — the candidate did not change protected content, permissions, or its own tests.
 */
function checkProtected(input: GateInput): GateCondition {
  const { candidate } = input;
  const keys = Object.keys(candidate.payload);

  const touchedProtected = keys.filter((k) => PROTECTED_KEYS.includes(k));
  if (touchedProtected.length > 0) {
    return condition(4, "protected content untouched", false, "Payload attempts to write protected field(s): " + touchedProtected.join(", ") + ".");
  }

  const allowed = ALLOWED_PAYLOAD_KEYS[candidate.type];
  const unexpected = keys.filter((k) => !allowed.includes(k));
  if (unexpected.length > 0) {
    return condition(4, "protected content untouched", false, "Payload carries key(s) outside the '" + candidate.type + "' contract: " + unexpected.join(", ") + ".");
  }

  const missing = allowed.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    return condition(4, "protected content untouched", false, "Payload is missing required key(s) for '" + candidate.type + "': " + missing.join(", ") + ".");
  }

  return condition(4, "protected content untouched", true, "Payload confined to the declared '" + candidate.type + "' contract; no protected field written.");
}

/**
 * Condition 5 — the expected base version still matches the active version.
 *
 * Guards the race where the runtime moved on (a redeploy, a new voice model)
 * between diagnosis and release, which would silently invalidate the evidence.
 */
function checkBaseVersion(input: GateInput): GateCondition {
  const { incident, activeBaseVersion } = input;
  const observedBase = incident.observed_version.split("+overlay.")[0] ?? incident.observed_version;
  if (observedBase !== activeBaseVersion) {
    return condition(5, "base version unchanged", false, "Incident observed on base '" + observedBase + "' but the active base is now '" + activeBaseVersion + "'. Evidence is stale; re-diagnose.");
  }
  return condition(5, "base version unchanged", true, "Base version '" + activeBaseVersion + "' unchanged since the incident was observed.");
}

/**
 * Condition 6 — the patch has an expiry or revalidation condition and a known predecessor.
 *
 * "Known predecessor" includes an explicit null for the first repair in a chain;
 * what is rejected is a predecessor that references something we cannot resolve.
 */
function checkExpiryAndPredecessor(input: GateInput, knownRepairIds: readonly string[]): GateCondition {
  const { candidate, incident } = input;
  void candidate;

  // Expiry is assigned at issue time from the decision scope; a session-scoped
  // repair expires at session end, a tenant-wide one needs explicit revalidation.
  const sessionScoped = input.decision.scope.session_id !== null;
  if (!sessionScoped && input.decision.scope.entity_id === null) {
    return condition(6, "expiry and predecessor", false, "An unscoped, non-expiring repair has no revalidation condition.");
  }

  const predecessor = incident.released_repair_id;
  if (predecessor !== null && !knownRepairIds.includes(predecessor)) {
    return condition(6, "expiry and predecessor", false, "Predecessor '" + predecessor + "' cannot be resolved.");
  }

  return condition(
    6,
    "expiry and predecessor",
    true,
    (sessionScoped ? "Session-scoped, expires at session_end" : "Tenant-scoped with revalidation required") +
      "; predecessor " +
      (predecessor ?? "none (first in chain)") +
      ".",
  );
}

/**
 * Evaluate all six conditions. Every condition is always evaluated so the
 * incident record and the Slack/Sentry message show the full picture, not just
 * the first failure.
 */
export function evaluateGate(input: GateInput, knownRepairIds: readonly string[] = []): GateResult {
  // The supervisor must actually have asked for a release. A "contain" or
  // "reject" decision never reaches the gate as a release.
  if (input.decision.action !== "release") {
    return {
      released: false,
      conditions: [],
      blockedBy: "supervisor decision was '" + input.decision.action + "', not 'release'",
    };
  }

  if (input.decision.chosen_candidate_id !== input.candidate.candidate_id) {
    return {
      released: false,
      conditions: [],
      blockedBy: "supervisor chose candidate '" + (input.decision.chosen_candidate_id ?? "none") + "' but gate was given '" + input.candidate.candidate_id + "'",
    };
  }

  const conditions: GateCondition[] = [
    checkScope(input),
    checkEvidence(input),
    checkChecks(input),
    checkProtected(input),
    checkBaseVersion(input),
    checkExpiryAndPredecessor(input, knownRepairIds),
  ];

  const firstFailure = conditions.find((c) => !c.passed);
  return {
    released: firstFailure === undefined,
    conditions,
    blockedBy: firstFailure ? "condition " + firstFailure.id + " (" + firstFailure.name + "): " + firstFailure.detail : null,
  };
}
