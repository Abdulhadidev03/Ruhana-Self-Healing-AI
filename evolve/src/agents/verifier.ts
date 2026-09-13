// The adversarial verifier (plan §4).
//
// Its job is to REFUTE, not to confirm: "Counterexamples, preserved-invariant
// checks, independent audio assessments ... no need to trust the proposer's
// explanation." A candidate survives only when the verifier fails to break it.
//
// Two deliberate choices:
//
// 1. Candidates are tested through Part A's OWN buildSpeechInput. Verifying
//    against a reimplementation would prove the candidate works in a model of
//    the runtime rather than in the runtime. If the real speech-input builder
//    would not apply the repair, the fixture fails here rather than at wire-up.
//
// 2. Fixtures are loaded read-only from fixtures/protected/. The proposer has no
//    write access to them and CI re-runs them outside Evolve entirely (plan §11).

import { readFileSync } from "node:fs";
import type { Repair, RepairScope } from "../../../contracts/types.ts";
import { buildSpeechInput } from "../../../runtime/src/speech-input.ts";
import type { AudioJudge } from "../providers/audio-judge.ts";
import type { CandidateRenderer } from "../providers/renderer.ts";
import type { Candidate, FixtureResult, Verdict } from "../domain/model.ts";
import type { ReferenceRegistry } from "../domain/registry.ts";

/**
 * Acoustic score at or above which the target counts as matching the reference.
 *
 * Plan §6C: the judge's score is "an experimental judge, not a calibrated
 * probability of correctness". This constant is therefore an engineering
 * threshold on an uncalibrated signal, not a confidence level — and it is only
 * ever one of several checks, never the sole release criterion.
 */
export const ACOUSTIC_MATCH_THRESHOLD = 0.95;

export interface FixtureExpectation {
  entity_id: string | null;
  pronounced_as: "reference" | "default";
  unchanged_surfaces?: string[];
  other_entities_unchanged?: string[];
}

export interface Fixture {
  fixture_id: string;
  kind: "reproducer" | "regression" | "negative_control";
  required: boolean;
  description: string;
  intended_text: string;
  entities: { entity_id: string; surface: string }[];
  expect: FixtureExpectation;
}

export interface FixtureSet {
  tenant: string;
  voice_model_version: string;
  fixtures: Fixture[];
}

export function loadFixtures(path: string): FixtureSet {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as FixtureSet;
  if (!Array.isArray(parsed.fixtures) || parsed.fixtures.length === 0) {
    throw new Error("fixture set at " + path + " is empty; refusing to verify against nothing");
  }
  return parsed;
}

export function requiredFixtureIds(set: FixtureSet): string[] {
  return set.fixtures.filter((f) => f.required).map((f) => f.fixture_id);
}

/** Build the wire Repair a candidate would become, for testing purposes only. */
function candidateAsRepair(candidate: Candidate, scope: RepairScope): Repair {
  return {
    repair_id: "candidate:" + candidate.candidate_id,
    type: candidate.type,
    scope,
    payload: candidate.payload as unknown as Repair["payload"],
    expires: "session_end",
    predecessor: null,
  };
}

export class AdversarialVerifier {
  constructor(
    private readonly registry: ReferenceRegistry,
    private readonly renderer: CandidateRenderer,
    private readonly judge: AudioJudge,
    private readonly fixtureSet: FixtureSet,
  ) {}

  async verify(candidate: Candidate, tenant: string, entityId: string | null): Promise<Verdict> {
    const results: FixtureResult[] = [];
    const counterexamples: string[] = [];

    for (const fixture of this.fixtureSet.fixtures) {
      const result = await this.runFixture(candidate, fixture, tenant, entityId);
      results.push(result);
      if (!result.passed) counterexamples.push(fixture.fixture_id + ": " + result.detail);
    }

    // The acoustic assessment of the candidate on the reproducer, surfaced
    // separately so the supervisor and dashboard can show it.
    const acoustic = await this.assessOnReproducer(candidate, tenant, entityId);

    const failed = results.filter((r) => !r.passed);
    const refuted = failed.length > 0;

    return {
      candidate_id: candidate.candidate_id,
      refuted,
      reason: refuted
        ? "Refuted by " + failed.length + " fixture(s): " + failed.map((f) => f.fixture_id).join(", ")
        : "Could not refute: all " + results.length + " fixtures passed.",
      acoustic,
      fixture_results: results,
      counterexamples,
    };
  }

  private async assessOnReproducer(
    candidate: Candidate,
    tenant: string,
    entityId: string | null,
  ) {
    if (candidate.type !== "pronunciation" || !entityId) return null;
    const reproducer = this.fixtureSet.fixtures.find((f) => f.kind === "reproducer");
    if (!reproducer) return null;
    const record = this.registry.get(tenant, entityId);
    if (!record) return null;

    const audio = await this.renderFixture(candidate, reproducer, tenant, entityId);
    return this.judge.assess({
      candidate: audio,
      referenceAudioId: record.reference_audio_id,
      referencePhonemes: record.reference_phonemes,
      targetSurface: record.canonical_text,
      targetEntityId: entityId,
      neighbouringSurfaces: reproducer.expect.unchanged_surfaces ?? [],
    });
  }

  private async renderFixture(
    candidate: Candidate,
    fixture: Fixture,
    tenant: string,
    entityId: string | null,
  ) {
    const scope: RepairScope = { tenant, entity_id: entityId ?? "", session_id: undefined };
    const repairs = candidate.type === "pronunciation" ? [candidateAsRepair(candidate, scope)] : [];

    // Through Part A's real builder — see the header note.
    const entityRefs = fixture.entities.map((e) => ({ entity_id: e.entity_id, surface: e.surface }));
    const segments = buildSpeechInput(fixture.intended_text, entityRefs, repairs);

    return this.renderer.render({
      text: fixture.intended_text,
      segments,
      voice_model_version: this.fixtureSet.voice_model_version,
      cacheKey: candidate.candidate_id + ":" + fixture.fixture_id,
    });
  }

  private async runFixture(
    candidate: Candidate,
    fixture: Fixture,
    tenant: string,
    entityId: string | null,
  ): Promise<FixtureResult> {
    const negative = fixture.kind === "negative_control";
    const base = {
      fixture_id: fixture.fixture_id,
      description: fixture.description,
      negative_control: negative,
    };

    const scope: RepairScope = { tenant, entity_id: entityId ?? "", session_id: undefined };
    const repairs = candidate.type === "pronunciation" ? [candidateAsRepair(candidate, scope)] : [];
    const entityRefs = fixture.entities.map((e) => ({ entity_id: e.entity_id, surface: e.surface }));
    const segments = buildSpeechInput(fixture.intended_text, entityRefs, repairs);

    // --- Invariant 1: the display text must survive unchanged (plan §6C). ---
    const reconstructed = segments
      .map((s) => (s.kind === "text" ? s.text : s.display))
      .join("");
    if (reconstructed !== fixture.intended_text) {
      return {
        ...base,
        passed: false,
        detail:
          "Display text was altered by the repair. Expected " +
          JSON.stringify(fixture.intended_text) +
          " but reconstructed " +
          JSON.stringify(reconstructed) +
          ".",
      };
    }

    // --- Invariant 2: scope containment. -------------------------------
    // A repair scoped to one entity must never produce a phoneme segment for
    // any other entity. This is the structural half of "Asia stays Asia".
    const strayed = segments.filter(
      (s) => s.kind === "phoneme" && s.entity_id !== entityId,
    );
    if (strayed.length > 0) {
      return {
        ...base,
        passed: false,
        detail:
          "Repair scoped to '" +
          (entityId ?? "none") +
          "' applied to other entities: " +
          strayed.map((s) => (s.kind === "phoneme" ? s.entity_id : "")).join(", ") +
          ".",
      };
    }

    // --- Expectation: the entity must NOT be overridden. ----------------
    if (fixture.expect.pronounced_as === "default") {
      const overridden = segments.some(
        (s) => s.kind === "phoneme" && s.entity_id === fixture.expect.entity_id,
      );
      if (overridden) {
        return {
          ...base,
          passed: false,
          detail:
            "Entity '" +
            fixture.expect.entity_id +
            "' was overridden but this fixture requires it to keep the engine default.",
        };
      }
      // Nothing was touched, which is exactly what a negative control wants.
      return {
        ...base,
        passed: true,
        detail: negative
          ? "Repair correctly did not fire on this unrelated content."
          : "Entity correctly left at engine default (no reference available).",
      };
    }

    // --- Expectation: the entity must be pronounced per the reference. ---
    const record = fixture.expect.entity_id ? this.registry.get(tenant, fixture.expect.entity_id) : null;
    if (!record || !record.reference_phonemes) {
      return {
        ...base,
        passed: false,
        detail:
          "Fixture expects a reference pronunciation for '" +
          (fixture.expect.entity_id ?? "none") +
          "' but the registry holds none.",
      };
    }

    const audio = await this.renderFixture(candidate, fixture, tenant, entityId);
    const assessment = await this.judge.assess({
      candidate: audio,
      referenceAudioId: record.reference_audio_id,
      referencePhonemes: record.reference_phonemes,
      targetSurface: record.canonical_text,
      targetEntityId: fixture.expect.entity_id,
      neighbouringSurfaces: fixture.expect.unchanged_surfaces ?? [],
    });

    if (assessment.match_score < ACOUSTIC_MATCH_THRESHOLD) {
      return {
        ...base,
        passed: false,
        detail:
          "Acoustic judge scored the target at " +
          assessment.match_score.toFixed(2) +
          " against the reference (threshold " +
          ACOUSTIC_MATCH_THRESHOLD +
          "). " +
          assessment.notes,
      };
    }

    if (assessment.collateral_flags.length > 0) {
      return {
        ...base,
        passed: false,
        detail: "Judge flagged collateral change to: " + assessment.collateral_flags.join(", ") + ".",
      };
    }

    // --- Invariant 3: collision with a neighbouring entity. -------------
    // The plan's rejection proof (§12): a candidate that fixes the target but
    // makes it indistinguishable from a different registered person is harmful
    // even though the target itself now "matches".
    for (const otherId of fixture.expect.other_entities_unchanged ?? []) {
      const other = this.registry.get(tenant, otherId);
      if (!other?.reference_phonemes) continue;
      const candidatePhonemes = (candidate.payload as { phonemes?: string }).phonemes;
      if (candidatePhonemes && candidatePhonemes === other.reference_phonemes) {
        return {
          ...base,
          passed: false,
          detail:
            "Candidate pronounces '" +
            record.canonical_text +
            "' identically to a different registered entity '" +
            otherId +
            "' (" +
            other.canonical_text +
            "). The two people would become indistinguishable.",
        };
      }
    }

    return {
      ...base,
      passed: true,
      detail:
        "Target matched the reference (score " +
        assessment.match_score.toFixed(2) +
        "); no collateral or scope violation.",
    };
  }
}
