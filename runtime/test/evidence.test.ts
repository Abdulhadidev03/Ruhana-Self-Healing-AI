import { describe, expect, it, vi } from "vitest";
import { HttpEvidenceSink, TurnEvidenceBuilder } from "../src/evidence.ts";

const ids = {
  tenant: "demo",
  sessionId: "s-42",
  turnId: "t-1",
  utteranceId: "t-1-u1",
  effectiveVersion: "base-1+overlay.0",
};

describe("TurnEvidenceBuilder", () => {
  it("assembles a complete evidence turn", () => {
    const evidence = new TurnEvidenceBuilder(ids)
      .recordMicAudio("store://mic/1")
      .recordTranscript({ text: "hello", model: "mock-stt-1" })
      .recordEntities([{ entity_id: "demo-person-17", surface: "Ayesha" }])
      .recordIntendedText("Hello Ayesha")
      .recordSpeechInput([{ kind: "text", text: "Hello Ayesha" }])
      .recordGeneratedAudio("store://tts/1")
      .recordDelivery({ type: "passthrough_submitted", client_ts: 10 })
      .recordInjectedFault("seeded-pronunciation-drop")
      .build(new Date("2026-09-14T00:00:00Z"));

    expect(evidence.effective_version).toBe("base-1+overlay.0");
    expect(evidence.injected_fault).toBe("seeded-pronunciation-drop");
    expect(evidence.delivery_events).toHaveLength(1);
    expect(evidence.server_ts).toBe("2026-09-14T00:00:00.000Z");
  });

  it("rejects missing ids", () => {
    expect(() => new TurnEvidenceBuilder({ ...ids, turnId: "" }).build()).toThrow(/turnId/);
  });
});

describe("HttpEvidenceSink", () => {
  it("retries failed posts and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const sink = new HttpEvidenceSink("http://evolve", fetchMock as unknown as typeof fetch);
    await sink.post(new TurnEvidenceBuilder(ids).build());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const sink = new HttpEvidenceSink("http://evolve", fetchMock as unknown as typeof fetch, 2);
    await expect(sink.post(new TurnEvidenceBuilder(ids).build())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
