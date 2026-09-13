// The machine release gate (plan §10).
//
// Each of the six conditions is tested by failing it ALONE, with every other
// condition satisfied. A gate test that fails two conditions at once cannot tell
// you which one did the work.

import { describe, expect, it } from "vitest";
import { evaluateGate } from "../src/domain/gate.ts";
import type {
  Candidate,
  GateInput,
  Incident,
  SupervisorDecision,
  Verdict,
} from "../src/domain/model.ts";

const INCIDENT: Incident = {
  incident_id: "inc-1",
  tenant: "demo",
  session_id: "s-42",
  turn_id: "t-1",
  utterance_id: "t-1-u1",
  layer: "pronunciation",
  entity_id: "demo-person-17",
  observed_version: "base-1+overlay.0",
  evidence_ids: ["ev-1"],
  summary: "mispronounced",
  status: "open",
  opened_at: 1,
  released_repair_id: null,
  injected_fault: null,
};

const CANDIDATE: Candidate = {
  candidate_id: "cand-1",
  incident_id: "inc-1",
  type: "pronunciation",
  payload: { phonemes: "/ɑːˈjeɪʃə/", voice_model_version: "kokoro-82m/af_heart" },
  rationale: "derived from the reference",
  audio: null,
  payload_hash: "hash-1",
};

const VERDICT: Verdict = {
  candidate_id: "cand-1",
  refuted: false,
  reason: "could not refute",
  acoustic: null,
  fixture_results: [
    { fixture_id: "fx-a", description: "", passed: true, detail: "", negative_control: false },
    { fixture_id: "fx-b", description: "", passed: true, detail: "", negative_control: true },
  ],
  counterexamples: [],
};

const DECISION: SupervisorDecision = {
  action: "release",
  chosen_candidate_id: "cand-1",
  rejected_candidate_ids: [],
  rationale: "verified",
  scope: { tenant: "demo", entity_id: "demo-person-17", session_id: "s-42" },
};

function baseInput(): GateInput {
  return {
    incident: INCIDENT,
    candidate: CANDIDATE,
    verdict: VERDICT,
    decision: DECISION,
    activeBaseVersion: "base-1",
    requiredFixtureIds: ["fx-a", "fx-b"],
    knownEvidenceIds: ["ev-1"],
    allowedTypes: ["pronunciation", "entity_rebinding"],
    allowedEntityIds: ["demo-person-17", "demo-person-22"],
  };
}

describe("machine release gate", () => {
  it("releases when all six conditions hold", () => {
    const result = evaluateGate(baseInput());
    expect(result.released).toBe(true);
    expect(result.conditions).toHaveLength(6);
    expect(result.blockedBy).toBeNull();
  });

  it("condition 1 — rejects a repair type the tenant does not permit", () => {
    const input = baseInput();
    input.allowedTypes = ["entity_rebinding"];
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("condition 1");
  });

  it("condition 1 — rejects a repair that widens beyond the incident entity", () => {
    const input = baseInput();
    input.decision = { ...DECISION, scope: { ...DECISION.scope, entity_id: "demo-person-22" } };
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("condition 1");
    expect(r.blockedBy).toContain("demo-person-22");
  });

  it("condition 2 — rejects when referenced evidence cannot be retrieved", () => {
    const input = baseInput();
    input.knownEvidenceIds = [];
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("condition 2");
  });

  it("condition 3 — rejects a refuted candidate", () => {
    const input = baseInput();
    input.verdict = { ...VERDICT, refuted: true, reason: "broke fixture fx-b" };
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("condition 3");
  });

  it("condition 3 — a required fixture that did not RUN is not a pass", () => {
    // Silent missing coverage is the failure mode this condition exists for.
    const input = baseInput();
    input.requiredFixtureIds = ["fx-a", "fx-b", "fx-never-ran"];
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("did not run");
    expect(r.blockedBy).toContain("fx-never-ran");
  });

  it("condition 4 — rejects a payload that writes a protected field", () => {
    const input = baseInput();
    input.candidate = {
      ...CANDIDATE,
      payload: { ...CANDIDATE.payload, reference_phonemes: "/whatever-i-want/" },
    };
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("condition 4");
    expect(r.blockedBy).toContain("reference_phonemes");
  });

  it("condition 4 — rejects a payload carrying keys outside its contract", () => {
    const input = baseInput();
    input.candidate = { ...CANDIDATE, payload: { ...CANDIDATE.payload, shell_command: "rm -rf /" } };
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("shell_command");
  });

  it("condition 5 — rejects when the base version moved since the incident", () => {
    const input = baseInput();
    input.activeBaseVersion = "base-2";
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("condition 5");
    expect(r.blockedBy).toContain("stale");
  });

  it("condition 6 — rejects an unresolvable predecessor", () => {
    const input = baseInput();
    input.incident = { ...INCIDENT, released_repair_id: "r-ghost" };
    const r = evaluateGate(input, []); // no known repair ids
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("condition 6");
  });

  it("condition 6 — accepts a known predecessor", () => {
    const input = baseInput();
    input.incident = { ...INCIDENT, released_repair_id: "r-8" };
    const r = evaluateGate(input, ["r-8"]);
    expect(r.released).toBe(true);
  });

  it("never releases on a non-release decision, whatever else passes", () => {
    for (const action of ["reject", "contain", "request_more_evidence"] as const) {
      const input = baseInput();
      input.decision = { ...DECISION, action };
      const r = evaluateGate(input);
      expect(r.released).toBe(false);
      expect(r.blockedBy).toContain(action);
    }
  });

  it("refuses when the supervisor's chosen candidate is not the one handed to the gate", () => {
    const input = baseInput();
    input.decision = { ...DECISION, chosen_candidate_id: "cand-other" };
    const r = evaluateGate(input);
    expect(r.released).toBe(false);
    expect(r.blockedBy).toContain("cand-other");
  });

  it("reports every condition, not just the first failure", () => {
    const r = evaluateGate(baseInput());
    expect(r.conditions.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.conditions.every((c) => c.detail.length > 0)).toBe(true);
  });
});
