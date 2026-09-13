// Part B internal domain model.
//
// These types live ONLY inside Evolve. The wire types in contracts/types.ts are
// owned jointly with Part A and are not changed here. Where the plan requires
// something the wire contract does not yet carry (notably the signed artifact
// hash of plan §10), it is held internally and surfaced through Evolve's own
// dashboard API rather than by editing the shared contract.

import type { EvidenceTurn, Repair, RepairType } from "../../../contracts/types.ts";

/** Layer a failure is attributed to. Mirrors the failure table of plan §2. */
export type Layer =
  | "recognition"
  | "memory"
  | "pronunciation"
  | "runtime"
  | "video"
  | "undetermined";

/**
 * An entity record in the Ruhana Voice Memory registry (plan §7, §15).
 *
 * Reference fields are IMMUTABLE from a repair agent's perspective: a candidate
 * must never be able to redefine the correct answer to make itself pass.
 */
export interface EntityRecord {
  entity_id: string;
  tenant: string;
  canonical_text: string;
  language: string;
  /** Link to the human reference recording. Absence is a first-class state. */
  reference_audio_id: string | null;
  /**
   * Ground-truth pronunciation derived from the reference recording.
   * null means "no trustworthy reference" — plan §2 requires the system to keep
   * competing hypotheses or abstain rather than invent one.
   */
  reference_phonemes: string | null;
  recognition_hints: string[];
  /** Counterexamples (plan §7): surfaces this entity's repair must never rewrite. */
  must_not_rewrite: string[];
  /** Voice/model version the reference was captured against. */
  voice_model_version: string | null;
  status: "active" | "quarantined";
}

/** What a renderer produced. Fakes report phonemes; real engines require acoustic judging. */
export interface AudioRef {
  url: string;
  /**
   * What the renderer actually pronounced, when the renderer can self-report.
   * Local Kokoro can report this; a managed provider generally cannot, in which
   * case it stays null and the acoustic judge is the only evidence.
   */
  rendered_phonemes: string | null;
  /**
   * Phonemes actually rendered per token, keyed by entity_id for overridden
   * entities and by the bare surface word otherwise.
   *
   * This exists because a judge assesses ONE word, while rendered_phonemes
   * covers the whole utterance. Comparing a sentence against a single word's
   * reference scores every candidate near zero — the bug this field fixes.
   * Real acoustic judges ignore it and listen to the audio instead.
   */
  rendered_tokens: Record<string, string> | null;
  duration_ms: number;
}

export interface Incident {
  incident_id: string;
  tenant: string;
  session_id: string;
  turn_id: string;
  utterance_id: string;
  layer: Layer;
  entity_id: string | null;
  /** Version the failure was observed under (plan §10 gate condition 5). */
  observed_version: string;
  /** Evidence ids backing this incident. */
  evidence_ids: string[];
  summary: string;
  status: "open" | "repairing" | "resolved" | "rejected" | "rolled_back" | "contained";
  opened_at: number;
  /** Set once a repair released for this incident. */
  released_repair_id: string | null;
  /** Labelled demo fault, echoed from Part A's injector. Never inferred. */
  injected_fault: string | null;
}

/** A specialist's bounded, typed finding (plan §4 discussion protocol). */
export interface Finding {
  specialist: "perception" | "memory" | "speech" | "runtime";
  /** What the specialist believes happened. */
  hypothesis: string;
  /** Which layer it attributes the failure to, or undetermined. */
  layer: Layer;
  /** Evidence ids actually inspected — not a summary of someone else's conclusion. */
  evidence_refs: string[];
  /** Plan §4: every hypothesis carries a condition that would disprove it. */
  disconfirming_condition: string;
  /** 0..1 self-reported. Plan §10: never sufficient on its own for release. */
  confidence: number;
  /** Present only when this specialist can propose a concrete experiment. */
  proposed_experiment: ProposedExperiment | null;
  /**
   * Further experiments this specialist would also accept testing. Plan §12
   * step 4 expects the speech specialist to offer TWO candidate renderings, and
   * plan §9 caps the total at two — the supervisor picks from here.
   */
  alternative_experiments?: ProposedExperiment[];
}

export interface ProposedExperiment {
  type: RepairType;
  /** Human-readable rationale, shown in the dashboard and Slack thread. */
  rationale: string;
  /** The concrete payload to test, in wire-contract shape. */
  payload: Record<string, unknown>;
}

/** A rendered, testable candidate repair. */
export interface Candidate {
  candidate_id: string;
  incident_id: string;
  type: RepairType;
  payload: Record<string, unknown>;
  rationale: string;
  /** Audio produced by rendering this candidate, for pronunciation candidates. */
  audio: AudioRef | null;
  payload_hash: string;
}

/** One protected-fixture check result. */
export interface FixtureResult {
  fixture_id: string;
  description: string;
  passed: boolean;
  detail: string;
  /** True when this fixture exists to prove the repair does NOT fire (negative control). */
  negative_control: boolean;
}

/** The adversarial verifier's verdict on one candidate (plan §4). */
export interface Verdict {
  candidate_id: string;
  /** The verifier's job is to REFUTE. Survives only if it cannot. */
  refuted: boolean;
  reason: string;
  /** Independent acoustic assessment, when the candidate produced audio. */
  acoustic: AcousticAssessment | null;
  fixture_results: FixtureResult[];
  /** Fixtures that failed — the counterexamples recorded on rejection (plan §10). */
  counterexamples: string[];
}

export interface AcousticAssessment {
  /** 0..1 similarity to the reference. An experimental judge, NOT a calibrated probability (plan §6C). */
  match_score: number;
  /** Model that produced the assessment, for the evidence record. */
  judge_model: string;
  /** Words other than the target that the judge flagged as altered. */
  collateral_flags: string[];
  notes: string;
}

/** The supervisor's structured decision (plan §4, §10). */
export interface SupervisorDecision {
  action: "release" | "reject" | "contain" | "request_more_evidence";
  chosen_candidate_id: string | null;
  rejected_candidate_ids: string[];
  rationale: string;
  /** Scope the supervisor is willing to release into. */
  scope: { tenant: string; entity_id: string | null; session_id: string | null };
}

/** Immutable released artifact (plan §10). Hash proves integrity, not correctness. */
export interface RepairArtifact {
  repair_id: string;
  incident_id: string;
  /** The exact wire repair handed to the runtime. */
  repair: Repair;
  /** sha256 over the canonical repair body. */
  artifact_hash: string;
  issuer: string;
  issued_at: number;
  /** Overlay version this artifact was released into. */
  overlay_version: number;
  /** Base version asserted at release (plan §10 condition 5). */
  base_version: string;
  status: "active" | "rolled_back" | "expired";
}

export interface GateInput {
  incident: Incident;
  candidate: Candidate;
  verdict: Verdict;
  decision: SupervisorDecision;
  /** The version the runtime is currently on, checked against the incident. */
  activeBaseVersion: string;
  /** Fixture ids the gate REQUIRES to have run, from the protected set. */
  requiredFixtureIds: string[];
  /** Evidence ids the store can actually produce. */
  knownEvidenceIds: string[];
  /** Repair types this tenant permits. */
  allowedTypes: RepairType[];
  /** Entity ids this tenant permits repairs for. */
  allowedEntityIds: string[];
}

export interface GateCondition {
  id: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  passed: boolean;
  detail: string;
}

export interface GateResult {
  released: boolean;
  conditions: GateCondition[];
  /** First failing condition, for the incident record and Slack message. */
  blockedBy: string | null;
}

export interface EvidenceRecord {
  evidence_id: string;
  turn: EvidenceTurn;
  received_at: number;
}
