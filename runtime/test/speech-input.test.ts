import { describe, expect, it } from "vitest";
import { buildSpeechInput, displayTextOf } from "../src/speech-input.ts";
import type { EntityRef, Repair } from "../../contracts/types.ts";

const ayesha: EntityRef = { entity_id: "demo-person-17", surface: "Ayesha", canonical_text: "Ayesha" };
const repair: Repair = {
  repair_id: "r-1",
  type: "pronunciation",
  scope: { tenant: "demo", entity_id: "demo-person-17", session_id: "s-42" },
  payload: { phonemes: "aɪˈiːʃə", voice_model_version: "mock-voice-1" },
  expires: "session_end",
  predecessor: null,
};

describe("buildSpeechInput", () => {
  it("replaces only the scoped entity surface with phonemes", () => {
    const segments = buildSpeechInput("Hello Ayesha, welcome back.", [ayesha], [repair]);
    expect(segments).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "phoneme", display: "Ayesha", phonemes: "aɪˈiːʃə", entity_id: "demo-person-17" },
      { kind: "text", text: ", welcome back." },
    ]);
  });

  it("preserves the display text exactly", () => {
    const text = "Hello Ayesha, Ayesha is here.";
    const segments = buildSpeechInput(text, [ayesha], [repair]);
    expect(displayTextOf(segments)).toBe(text);
    expect(segments.filter((s) => s.kind === "phoneme")).toHaveLength(2);
  });

  it("negative control: 'Asia' stays untouched when the repair targets a person", () => {
    const asia: EntityRef = { entity_id: "continent-asia", surface: "Asia" };
    const segments = buildSpeechInput(
      "Asia is the largest continent.",
      [asia],
      [repair], // repair is scoped to demo-person-17, not the continent
    );
    expect(segments).toEqual([{ kind: "text", text: "Asia is the largest continent." }]);
  });

  it("does not rewrite substrings inside other words", () => {
    const segments = buildSpeechInput("Ayeshas book", [ayesha], [repair]);
    expect(segments).toEqual([{ kind: "text", text: "Ayeshas book" }]);
  });

  it("no repairs means one plain text segment", () => {
    const segments = buildSpeechInput("Hello Ayesha.", [ayesha], []);
    expect(segments).toEqual([{ kind: "text", text: "Hello Ayesha." }]);
  });

  it("later repairs supersede earlier ones for the same entity", () => {
    const better: Repair = {
      ...repair,
      repair_id: "r-2",
      payload: { phonemes: "ɑːˈjeːʃa", voice_model_version: "mock-voice-1" },
      predecessor: "r-1",
    };
    const segments = buildSpeechInput("Hi Ayesha", [ayesha], [repair, better]);
    const phoneme = segments.find((s) => s.kind === "phoneme");
    expect(phoneme && "phonemes" in phoneme && phoneme.phonemes).toBe("ɑːˈjeːʃa");
  });
});
