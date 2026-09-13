// Discrepancy detection (plan §2, §3): the cheap structural signal that opens
// an incident.
//
// Detection deliberately does NOT decide what went wrong. It notices that the
// four representations disagree and names a SUSPECTED layer. Confirming the
// layer is the specialists' job, using the actual audio — plan §2 is explicit
// that "a transcript cannot establish the pronunciation of an audio clip".
// Treating a structural hint as a diagnosis is the shortcut the plan forbids.

import type { EvidenceTurn, SpeechSegment } from "../../../contracts/types.ts";
import type { EntityRecord, Layer } from "./model.ts";
import type { ReferenceRegistry } from "./registry.ts";

export interface Discrepancy {
  layer: Layer;
  entity_id: string | null;
  summary: string;
  /** Ground truth from the reference recording, when one exists. */
  expected_phonemes: string | null;
  /** What the runtime actually submitted for this entity, if anything. */
  submitted_phonemes: string | null;
  /** Why this is only a suspicion, in the incident record. */
  requires_confirmation: boolean;
}

function phonemeSegmentFor(
  segments: readonly SpeechSegment[] | undefined,
  entityId: string,
): Extract<SpeechSegment, { kind: "phoneme" }> | null {
  if (!segments) return null;
  for (const s of segments) {
    if (s.kind === "phoneme" && s.entity_id === entityId) return s;
  }
  return null;
}

function containsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = haystack[idx - 1];
    const after = haystack[idx + needle.length];
    const boundary = (ch: string | undefined) => ch === undefined || !/[\p{L}\p{N}]/u.test(ch);
    if (boundary(before) && boundary(after)) return true;
    from = idx + needle.length;
  }
}

/** Levenshtein distance, used only to spot near-miss transcriptions. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n]!;
}

/**
 * Pronunciation: the intended text carries the right name, but the speech
 * representation submitted for it does not match the reference (plan §2).
 *
 * This is the seeded-pronunciation-drop case from Part A's failure injector:
 * the repair is filtered out, so the entity reaches TTS as plain text and is
 * pronounced by the engine's default grapheme-to-phoneme guess.
 */
function detectPronunciation(
  turn: EvidenceTurn,
  record: EntityRecord,
  entitySurface: string,
): Discrepancy | null {
  // No reference recording means no ground truth. Plan §2: keep competing
  // hypotheses or abstain — never invent a correct pronunciation.
  if (!record.reference_phonemes) return null;

  const intended = turn.intended_text ?? "";
  if (!containsWord(intended, entitySurface)) return null;

  const seg = phonemeSegmentFor(turn.speech_input, record.entity_id);

  if (!seg) {
    return {
      layer: "pronunciation",
      entity_id: record.entity_id,
      summary:
        "Entity '" +
        entitySurface +
        "' was submitted to TTS as plain text with no pronunciation override, " +
        "while the registry holds a reference pronunciation for it.",
      expected_phonemes: record.reference_phonemes,
      submitted_phonemes: null,
      requires_confirmation: true,
    };
  }

  if (seg.phonemes !== record.reference_phonemes) {
    return {
      layer: "pronunciation",
      entity_id: record.entity_id,
      summary:
        "Submitted phonemes for '" + entitySurface + "' differ from the reference pronunciation.",
      expected_phonemes: record.reference_phonemes,
      submitted_phonemes: seg.phonemes,
      requires_confirmation: true,
    };
  }

  return null;
}

/**
 * Memory: the transcript identifies the right person, but the response uses
 * another name for them (plan §2, memory row).
 */
function detectMemory(turn: EvidenceTurn, record: EntityRecord): Discrepancy | null {
  const heard = turn.primary_transcript?.text ?? "";
  const intended = turn.intended_text ?? "";
  if (!heard || !intended) return null;

  const canonical = record.canonical_text;
  const heardCanonical = containsWord(heard, canonical) || record.recognition_hints.some((h) => containsWord(heard, h));
  if (!heardCanonical) return null;

  // The caller named the entity; if the reply names it too, nothing to see.
  if (containsWord(intended, canonical)) return null;

  // The reply used a DIFFERENT surface for the same bound entity.
  const boundSurface = turn.entities.find((e) => e.entity_id === record.entity_id)?.surface;
  if (boundSurface && boundSurface !== canonical && containsWord(intended, boundSurface)) {
    return {
      layer: "memory",
      entity_id: record.entity_id,
      summary:
        "Caller said '" +
        canonical +
        "' but the response referred to the same entity as '" +
        boundSurface +
        "'.",
      expected_phonemes: null,
      submitted_phonemes: null,
      requires_confirmation: true,
    };
  }
  return null;
}

/**
 * Recognition: a near-miss of a registered entity in the transcript.
 *
 * This is the weakest signal in the file and is treated as such. Two recognizers
 * can agree on the same wrong spelling (plan §2), so this only opens an incident
 * for the perception specialist to confirm with an independent decode. Surfaces
 * listed in must_not_rewrite are skipped outright — that is the "Asia stays
 * Asia" negative control of plan §6A, enforced before any agent runs.
 */
function detectRecognition(turn: EvidenceTurn, record: EntityRecord): Discrepancy | null {
  const heard = turn.primary_transcript?.text ?? "";
  if (!heard) return null;

  const canonical = record.canonical_text;
  if (containsWord(heard, canonical)) return null; // recognized correctly

  for (const word of heard.split(/[^\p{L}\p{N}']+/u)) {
    if (!word) continue;
    if (record.must_not_rewrite.some((w) => w.toLowerCase() === word.toLowerCase())) continue;
    if (record.recognition_hints.some((h) => h.toLowerCase() === word.toLowerCase())) continue;

    const d = editDistance(word.toLowerCase(), canonical.toLowerCase());
    const near = d > 0 && d <= Math.max(1, Math.floor(canonical.length / 4));
    if (near) {
      return {
        layer: "recognition",
        entity_id: record.entity_id,
        summary:
          "Transcript contains '" +
          word +
          "', a near-miss of registered entity '" +
          canonical +
          "' (edit distance " +
          d +
          "). Requires an independent decode to confirm.",
        expected_phonemes: null,
        submitted_phonemes: null,
        requires_confirmation: true,
      };
    }
  }
  return null;
}

/**
 * Runtime: audio delivered after the turn was superseded, or duplicated
 * playback (plan §2, runtime row).
 */
function detectRuntime(turn: EvidenceTurn): Discrepancy | null {
  const events = turn.delivery_events;
  const supersededAt = events.find((e) => e.type === "superseded")?.client_ts;
  if (supersededAt !== undefined) {
    const lateStart = events.find((e) => e.type === "playback_start" && e.client_ts > supersededAt);
    if (lateStart) {
      return {
        layer: "runtime",
        entity_id: null,
        summary:
          "Playback started at " +
          lateStart.client_ts +
          "ms, after the turn was superseded at " +
          supersededAt +
          "ms.",
        expected_phonemes: null,
        submitted_phonemes: null,
        requires_confirmation: false,
      };
    }
  }
  const starts = events.filter((e) => e.type === "playback_start").length;
  if (starts > 1) {
    return {
      layer: "runtime",
      entity_id: null,
      summary: "Utterance reported " + starts + " playback_start events; expected at most one.",
      expected_phonemes: null,
      submitted_phonemes: null,
      requires_confirmation: false,
    };
  }
  return null;
}

/**
 * Run every detector. Returns all discrepancies found, most specific first.
 *
 * Order matters only for which incident is opened first; each discrepancy gets
 * its own incident so two simultaneous failures are never collapsed into one.
 */
export function detect(turn: EvidenceTurn, registry: ReferenceRegistry): Discrepancy[] {
  const found: Discrepancy[] = [];

  const runtime = detectRuntime(turn);
  if (runtime) found.push(runtime);

  // Entities referenced by this turn, plus anything registered that appears in
  // the intended text (an entity can be spoken without having been bound).
  const seen = new Set<string>();
  for (const ref of turn.entities) {
    const record = registry.get(turn.tenant, ref.entity_id);
    if (!record || record.status === "quarantined") continue;
    if (seen.has(record.entity_id)) continue;
    seen.add(record.entity_id);

    const memory = detectMemory(turn, record);
    if (memory) found.push(memory);

    const recognition = detectRecognition(turn, record);
    if (recognition) found.push(recognition);

    const pron = detectPronunciation(turn, record, ref.surface);
    if (pron) found.push(pron);
  }

  return found;
}
