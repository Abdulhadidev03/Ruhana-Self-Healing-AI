// Builds the speech representation from the intended display text (plan §6C:
// canonical display text, speech representation, and actual audio are three
// separate things). Only exact entity surfaces are replaced, and only when a
// verified pronunciation repair is scoped to that entity — a global
// find-and-replace is exactly the shortcut the plan forbids.

import type { EntityRef, Repair, SpeechSegment } from "../../contracts/types.ts";

function pronunciationFor(entityId: string, repairs: readonly Repair[]) {
  // Later repairs supersede earlier ones for the same entity.
  for (let i = repairs.length - 1; i >= 0; i--) {
    const r = repairs[i]!;
    if (r.type === "pronunciation" && r.scope.entity_id === entityId) {
      return r.payload as { phonemes: string };
    }
  }
  return null;
}

function isWordBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[\p{L}\p{N}]/u.test(ch);
}

export function buildSpeechInput(
  intendedText: string,
  entities: readonly EntityRef[],
  repairs: readonly Repair[],
): SpeechSegment[] {
  // Collect whole-word matches for entities that actually have a repair.
  const matches: { start: number; end: number; entity: EntityRef; phonemes: string }[] = [];
  for (const entity of entities) {
    const repair = pronunciationFor(entity.entity_id, repairs);
    if (!repair) continue;
    const surface = entity.surface;
    let from = 0;
    while (true) {
      const idx = intendedText.indexOf(surface, from);
      if (idx === -1) break;
      const before = intendedText[idx - 1];
      const after = intendedText[idx + surface.length];
      if (isWordBoundary(before) && isWordBoundary(after)) {
        matches.push({ start: idx, end: idx + surface.length, entity, phonemes: repair.phonemes });
      }
      from = idx + surface.length;
    }
  }
  matches.sort((a, b) => a.start - b.start);

  const segments: SpeechSegment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlapping match already consumed
    if (m.start > cursor) segments.push({ kind: "text", text: intendedText.slice(cursor, m.start) });
    segments.push({
      kind: "phoneme",
      display: intendedText.slice(m.start, m.end),
      phonemes: m.phonemes,
      entity_id: m.entity.entity_id,
    });
    cursor = m.end;
  }
  if (cursor < intendedText.length) segments.push({ kind: "text", text: intendedText.slice(cursor) });
  if (segments.length === 0) segments.push({ kind: "text", text: intendedText });
  return segments;
}

/** The display text must be reconstructable from the speech input unchanged. */
export function displayTextOf(segments: readonly SpeechSegment[]): string {
  return segments.map((s) => (s.kind === "text" ? s.text : s.display)).join("");
}
