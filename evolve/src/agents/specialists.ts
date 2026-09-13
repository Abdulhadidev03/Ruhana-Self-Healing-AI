// The specialist agents (plan §4 role table).
//
// Each takes only its own view of the evidence and returns a bounded, typed
// Finding. None of them can release anything; the strongest thing a specialist
// can do is propose one experiment.

import type { LLM } from "../providers/llm.ts";
import { parseJsonReply } from "../providers/llm.ts";
import type { AudioJudge } from "../providers/audio-judge.ts";
import type { Finding, Layer } from "../domain/model.ts";
import { editDistance } from "../domain/detection.ts";
import type { MemoryView, PerceptionView, SpeechView } from "./protocol.ts";
import { nullFinding } from "./protocol.ts";

const LAYERS: readonly Layer[] = [
  "recognition",
  "memory",
  "pronunciation",
  "runtime",
  "video",
  "undetermined",
];

function asLayer(value: unknown, fallback: Layer = "undetermined"): Layer {
  return typeof value === "string" && (LAYERS as readonly string[]).includes(value)
    ? (value as Layer)
    : fallback;
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : 0.5;
  return Math.max(0, Math.min(1, v));
}

/* ------------------------------------------------------------------ *
 * Perception — the input side
 * ------------------------------------------------------------------ */

export interface IndependentDecoder {
  /** A second decode that has NOT been shown the first recognizer's answer. */
  decode(micAudioUrl: string): Promise<{ text: string; model: string }>;
}

/**
 * Plan §6A: "Run a second decode or audio assessment without showing it the
 * first recognizer's answer." The decoder interface takes only the audio URL,
 * so the primary transcript cannot be leaked into it even by accident.
 */
export class PerceptionSpecialist {
  constructor(private readonly decoder: IndependentDecoder | null) {}

  async run(view: PerceptionView): Promise<Finding> {
    const primary = view.primary_transcript?.text;

    if (!view.mic_audio_url) {
      // Plan §2: "A transcript cannot establish the pronunciation of an audio
      // clip that was never retained." Absent audio is an abstention, not a pass.
      return nullFinding(
        "perception",
        view.evidence_id,
        "No microphone audio was retained for this turn, so no independent decode is possible. I cannot confirm or rule out a recognition fault.",
        "Retaining the mic segment would allow a second decode to settle this.",
      );
    }

    if (!this.decoder) {
      return nullFinding(
        "perception",
        view.evidence_id,
        "No independent decoder is configured; the primary transcript is unchecked.",
        "Configuring a second recognizer would allow this to be confirmed.",
      );
    }

    // A second recognizer that errors, rate-limits or times out must not take
    // the repair loop down with it. Losing the independent decode weakens the
    // evidence, so this degrades to an abstention rather than a failure — which
    // is also the honest report: we did not check, so we do not know.
    let independent: { text: string; model: string };
    try {
      independent = await this.decoder.decode(view.mic_audio_url);
    } catch (err) {
      return nullFinding(
        "perception",
        view.evidence_id,
        "The independent decode failed (" +
          String(err instanceof Error ? err.message : err) +
          "), so the primary transcript is unverified. I am not proposing a recognition repair on unchecked evidence.",
        "A successful second decode agreeing or disagreeing with the primary transcript.",
      );
    }

    // Do the two decoders agree? Agreement is weak evidence — plan §2 warns
    // "two recognizers can agree on the same wrong spelling" — but disagreement
    // is a concrete, actionable signal.
    if (primary && independent.text.trim() === primary.trim()) {
      return {
        specialist: "perception",
        hypothesis:
          "The independent decode (" +
          independent.model +
          ") reproduces the primary transcript exactly. I found no evidence for an input-recognition repair. Note that two recognizers can share the same error, so this is corroboration, not proof.",
        layer: "undetermined",
        evidence_refs: [view.evidence_id],
        disconfirming_condition:
          "A third decode, or a reference recording of the caller, disagreeing with both transcripts.",
        confidence: 0.6,
        proposed_experiment: null,
      };
    }

    // They disagree. Does the independent decode land on a known entity?
    for (const candidate of view.entity_candidates) {
      const hit =
        independent.text.toLowerCase().includes(candidate.canonical_text.toLowerCase()) ||
        candidate.recognition_hints.some((h) =>
          independent.text.toLowerCase().includes(h.toLowerCase()),
        );
      if (!hit) continue;

      return {
        specialist: "perception",
        hypothesis:
          "The primary transcript reads " +
          JSON.stringify(primary ?? "") +
          " but the independent decode (" +
          independent.model +
          ") reads " +
          JSON.stringify(independent.text) +
          ", which resolves to registered entity '" +
          candidate.entity_id +
          "'. This supports a scoped recognition repair.",
        layer: "recognition",
        evidence_refs: [view.evidence_id],
        disconfirming_condition:
          "The reference recording matching the PRIMARY transcript instead, or the surface being a legitimate different word in context.",
        confidence: 0.7,
        proposed_experiment: {
          type: "entity_rebinding",
          rationale:
            "Rebind the turn to entity '" +
            candidate.entity_id +
            "' so the response uses the canonical spelling. The original transcript is preserved as evidence.",
          payload: {
            entity_id: candidate.entity_id,
            canonical_text: candidate.canonical_text,
          },
        },
      };
    }

    return nullFinding(
      "perception",
      view.evidence_id,
      "The two decodes disagree but neither resolves to a registered entity. I am not proposing a repair on ambiguous evidence.",
      "A reference recording, or an authenticated caller identity, would disambiguate.",
      "undetermined",
    );
  }
}

/* ------------------------------------------------------------------ *
 * Memory — entity bindings and intended text
 * ------------------------------------------------------------------ */

export class MemorySpecialist {
  async run(view: MemoryView): Promise<Finding> {
    const heard = view.primary_transcript_text ?? "";
    const intended = view.intended_text ?? "";

    if (!heard || !intended) {
      return nullFinding(
        "memory",
        view.evidence_id,
        "Missing transcript or intended text; cannot compare the binding.",
        "Both fields present in the evidence record.",
      );
    }

    for (const bound of view.bound_entities) {
      const record = view.entity_candidates.find((c) => c.entity_id === bound.entity_id);
      if (!record) continue;

      const canonical = record.canonical_text;
      const usedCanonical = intended.toLowerCase().includes(canonical.toLowerCase());
      if (usedCanonical) continue;

      // The reply referred to a bound entity by something other than its
      // canonical spelling. Plan §6B: this is the case where the agent
      // apologises and then drifts back to the old string because it still
      // dominates the conversation history.
      if (bound.surface && bound.surface !== canonical && intended.includes(bound.surface)) {
        return {
          specialist: "memory",
          hypothesis:
            "The response refers to entity '" +
            bound.entity_id +
            "' as '" +
            bound.surface +
            "' while the registry canonical spelling is '" +
            canonical +
            "'. The binding, not the synthesis, is wrong.",
          layer: "memory",
          evidence_refs: [view.evidence_id],
          disconfirming_condition:
            "The registry canonical spelling itself being wrong for this caller, or '" +
            bound.surface +
            "' being a deliberate nickname.",
          confidence: 0.75,
          proposed_experiment: {
            type: "entity_rebinding",
            rationale:
              "Rebind so the next draft uses the canonical spelling. Historical turns stay as evidence; only the current resolved state carries the correction.",
            payload: { entity_id: bound.entity_id, canonical_text: canonical },
          },
        };
      }
    }

    return nullFinding(
      "memory",
      view.evidence_id,
      "Every bound entity in the response uses its registry canonical spelling. I found no evidence for an entity-binding repair.",
      "A bound entity appearing under a non-canonical surface in the intended text.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * Speech — synthesis
 * ------------------------------------------------------------------ */

/**
 * The speech specialist is the only one that both inspects audio and proposes
 * phoneme candidates. Plan §7 is explicit that the winning pronunciation must
 * not be preselected: candidates are DERIVED from the reference recording and
 * then MEASURED by rendering and judging them. Deriving from the reference is
 * legitimate; asserting a winner without rendering it is not.
 */
export class SpeechSpecialist {
  constructor(
    private readonly llm: LLM,
    private readonly judge: AudioJudge,
    /** How many candidates to propose. Plan §9 caps a first repair at two. */
    private readonly maxCandidates = 2,
  ) {}

  async run(view: SpeechView): Promise<Finding> {
    const entity = view.target_entity;

    if (!entity) {
      return nullFinding(
        "speech",
        view.evidence_id,
        "No target entity was identified for this turn; nothing to assess acoustically.",
        "An entity with a reference recording appearing in the intended text.",
      );
    }

    if (!entity.reference_phonemes) {
      // Plan §2: without a trustworthy reference the honest move is to abstain
      // or avoid repeating the name — never to invent a pronunciation.
      return nullFinding(
        "speech",
        view.evidence_id,
        "Entity '" +
          entity.entity_id +
          "' has no reference recording. I will not propose a pronunciation without ground truth; the agent should avoid repeating the uncertain name instead.",
        "A reference recording being supplied for this entity.",
        "undetermined",
      );
    }

    // Assess the audio we actually emitted against the reference.
    let assessment = null;
    if (view.generated_audio) {
      assessment = await this.judge.assess({
        candidate: view.generated_audio,
        referenceAudioId: entity.reference_audio_id,
        referencePhonemes: entity.reference_phonemes,
        targetSurface: entity.canonical_text,
        targetEntityId: entity.entity_id,
        neighbouringSurfaces: [...view.neighbouring_surfaces],
      });
    }

    const intendedIsCorrect = (view.intended_text ?? "")
      .toLowerCase()
      .includes(entity.canonical_text.toLowerCase());

    // The signature of a synthesis fault: the text is right, the audio is not.
    const audioIsWrong = assessment !== null && assessment.match_score < 0.95;
    if (!intendedIsCorrect || !audioIsWrong) {
      return nullFinding(
        "speech",
        view.evidence_id,
        assessment === null
          ? "No generated audio was available to assess."
          : "Emitted audio matches the reference for '" +
              entity.canonical_text +
              "' (score " +
              assessment.match_score.toFixed(2) +
              "). I found no evidence for a pronunciation repair.",
        "Generated audio diverging from the reference while the intended text stays correct.",
      );
    }

    const candidates = await this.proposeCandidates(view, entity.canonical_text, entity.reference_phonemes);
    const first = candidates[0];

    return {
      specialist: "speech",
      hypothesis:
        "The intended text is correct but the emitted audio for '" +
        entity.canonical_text +
        "' diverges from the stored reference (acoustic score " +
        (assessment ? assessment.match_score.toFixed(2) : "n/a") +
        "). This isolates synthesis. Test " +
        candidates.length +
        " phoneme candidate(s) with text, voice and model held fixed.",
      layer: "pronunciation",
      evidence_refs: [view.evidence_id],
      disconfirming_condition:
        "A candidate that matches the reference phonemes still producing audio the judge scores as divergent — that would point at the renderer or the voice, not the phonemes.",
      confidence: 0.8,
      proposed_experiment: first
        ? {
            type: "pronunciation",
            rationale: first.rationale,
            payload: {
              phonemes: first.phonemes,
              voice_model_version: view.voice_model_version,
            },
          }
        : null,
      // Plan §12 step 4: the speech specialist proposes TWO candidate
      // renderings. Both must reach the verifier to be measured; offering only
      // the first would make the "two candidates" claim untrue.
      alternative_experiments: candidates.slice(1).map((c) => ({
        type: "pronunciation" as const,
        rationale: c.rationale,
        payload: { phonemes: c.phonemes, voice_model_version: view.voice_model_version },
      })),
    };
  }

  /**
   * Ask the model for alternative speech representations. Returned in priority
   * order and capped; plan §9 requires a bounded candidate count.
   */
  async proposeCandidates(
    view: SpeechView,
    surface: string,
    referencePhonemes: string,
  ): Promise<{ phonemes: string; rationale: string }[]> {
    const reply = await this.llm.complete({
      task: "speech.propose_candidates",
      maxTokens: 600,
      temperature: 0.3,
      system: [
        "You are the speech specialist in an automated voice-repair system.",
        "You propose alternative phoneme renderings for a single word and nothing else.",
        "A reference pronunciation, when supplied, is GROUND TRUTH derived from a human",
        "recording of how the person says their own name. It is stronger evidence than",
        "your own knowledge of how the name is usually pronounced. When a reference is",
        "supplied, your FIRST candidate must reproduce it EXACTLY, character for",
        "character. Use any remaining candidates for genuine alternatives.",
        "Reply only with JSON.",
      ].join(" "),
      user: JSON.stringify({
        target_surface: surface,
        reference_phonemes: referencePhonemes,
        current_speech_input: view.speech_input,
        words_that_must_not_change: view.neighbouring_surfaces,
        voice_model_version: view.voice_model_version,
        max_candidates: this.maxCandidates,
        reply_shape: { candidates: [{ phonemes: "string", rationale: "string" }] },
      }),
    });

    const parsed = parseJsonReply<{ candidates?: { phonemes?: string; rationale?: string }[] }>(
      reply.text,
    );
    const out: { phonemes: string; rationale: string }[] = [];
    for (const c of parsed.candidates ?? []) {
      if (typeof c.phonemes !== "string" || c.phonemes.length === 0) continue;
      out.push({ phonemes: c.phonemes, rationale: c.rationale ?? "no rationale given" });
      if (out.length >= this.maxCandidates) break;
    }
    return out;
  }
}

/** Exposed for the recognition-vs-negative-control tests. */
export function nearMiss(a: string, b: string): number {
  return editDistance(a.toLowerCase(), b.toLowerCase());
}

export { asLayer, clamp01 };
