// The discussion protocol (plan §4).
//
// Two rules from the plan are enforced structurally here rather than left to
// prompt discipline:
//
// 1. "Specialists inspect their own evidence before seeing others' conclusions."
//    Each specialist receives a NARROW slice of the evidence, built below. A
//    specialist cannot read a field it was not given, so it cannot accidentally
//    launder another agent's conclusion into its own finding.
//
// 2. "An agent is defined by its tools, evidence, and decision scope. Six
//    prompts sent to one model with the same transcript would not create six
//    independent sources of knowledge." The slices are genuinely different
//    views, taken from the §4 role table.

import type { EvidenceTurn, SpeechSegment } from "../../../contracts/types.ts";
import type { AudioRef, EntityRecord, Finding, Layer } from "../domain/model.ts";

/** What the perception specialist may see: the input side only. */
export interface PerceptionView {
  evidence_id: string;
  tenant: string;
  mic_audio_url: string | undefined;
  primary_transcript: { text: string; model: string; confidence?: number } | undefined;
  /** Entity candidates from the registry — reference data, read-only. */
  entity_candidates: readonly EntityRecord[];
  /** Deliberately absent: intended_text, speech_input, generated_audio_url. */
}

/** What the memory specialist may see: text and bindings, no audio. */
export interface MemoryView {
  evidence_id: string;
  tenant: string;
  primary_transcript_text: string | undefined;
  intended_text: string | undefined;
  bound_entities: readonly { entity_id: string; surface: string; canonical_text?: string }[];
  entity_candidates: readonly EntityRecord[];
  /** Deliberately absent: mic audio, generated audio, phonemes. */
}

/** What the speech specialist may see: the output side only. */
export interface SpeechView {
  evidence_id: string;
  tenant: string;
  intended_text: string | undefined;
  speech_input: readonly SpeechSegment[] | undefined;
  generated_audio: AudioRef | null;
  /** The reference recording for the entity under test. */
  target_entity: EntityRecord | null;
  /** Words that must not be altered by any repair (plan §7 counterexamples). */
  neighbouring_surfaces: readonly string[];
  voice_model_version: string;
  /** Deliberately absent: the mic track and the transcript. */
}

export function perceptionView(
  evidenceId: string,
  turn: EvidenceTurn,
  candidates: readonly EntityRecord[],
): PerceptionView {
  return {
    evidence_id: evidenceId,
    tenant: turn.tenant,
    mic_audio_url: turn.mic_audio_url,
    primary_transcript: turn.primary_transcript,
    entity_candidates: candidates,
  };
}

export function memoryView(
  evidenceId: string,
  turn: EvidenceTurn,
  candidates: readonly EntityRecord[],
): MemoryView {
  return {
    evidence_id: evidenceId,
    tenant: turn.tenant,
    primary_transcript_text: turn.primary_transcript?.text,
    intended_text: turn.intended_text,
    bound_entities: turn.entities.map((e) => ({
      entity_id: e.entity_id,
      surface: e.surface,
      canonical_text: e.canonical_text,
    })),
    entity_candidates: candidates,
  };
}

export function speechView(
  evidenceId: string,
  turn: EvidenceTurn,
  targetEntity: EntityRecord | null,
  generatedAudio: AudioRef | null,
  voiceModelVersion: string,
): SpeechView {
  const target = targetEntity?.canonical_text;
  const neighbours = (turn.intended_text ?? "")
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 1 && w !== target);
  return {
    evidence_id: evidenceId,
    tenant: turn.tenant,
    intended_text: turn.intended_text,
    speech_input: turn.speech_input,
    generated_audio: generatedAudio,
    target_entity: targetEntity,
    neighbouring_surfaces: [...new Set(neighbours)],
    voice_model_version: voiceModelVersion,
  };
}

/**
 * A finding with no proposal. Used when a specialist inspects its evidence and
 * finds nothing — which is a real, useful result, not a failure. Plan §12 step 3
 * depends on perception being able to say "I found no evidence for an
 * input-recognition repair".
 */
export function nullFinding(
  specialist: Finding["specialist"],
  evidenceRef: string,
  hypothesis: string,
  disconfirming: string,
  layer: Layer = "undetermined",
): Finding {
  return {
    specialist,
    hypothesis,
    layer,
    evidence_refs: [evidenceRef],
    disconfirming_condition: disconfirming,
    confidence: 0.5,
    proposed_experiment: null,
  };
}
