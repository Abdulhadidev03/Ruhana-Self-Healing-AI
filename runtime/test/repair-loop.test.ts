// End-to-end runtime-side test of the demo story (plan §12): a seeded fault
// makes the avatar mispronounce the name, evidence reaches the (mock) Evolve
// service, Evolve releases a scoped repair, and the NEXT eligible turn speaks
// the corrected pronunciation while unrelated words stay untouched.

import { describe, expect, it } from "vitest";
import { EvolveMock } from "../../contracts/mocks/evolve-mock.ts";
import { SessionOverlayStore } from "../src/overlay.ts";
import { TurnController } from "../src/turn-controller.ts";
import { MockTTSEngine } from "../src/tts/engine.ts";
import type { EvidenceSink } from "../src/evidence.ts";
import type { EvidenceTurn, Repair } from "../../contracts/types.ts";

class MockSink implements EvidenceSink {
  constructor(private readonly evolve: EvolveMock) {}
  posted: EvidenceTurn[] = [];
  async post(turn: EvidenceTurn): Promise<void> {
    this.posted.push(turn);
    this.evolve.receiveEvidence(turn);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const evolve = new EvolveMock();
  const store = new SessionOverlayStore("base-1", "demo", "s-42");
  const tts = new MockTTSEngine();
  const sink = new MockSink(evolve);
  const controller = new TurnController("demo", "s-42", store, tts, sink);
  return { evolve, store, tts, sink, controller };
}

const ayeshaBrain = async () => ({
  intendedText: "Welcome back, Ayesha! How can I help?",
  entities: [{ entity_id: "demo-person-17", surface: "Ayesha" }],
});

const repair: Repair = {
  repair_id: "r-9",
  type: "pronunciation",
  scope: { tenant: "demo", entity_id: "demo-person-17", session_id: "s-42" },
  payload: { phonemes: "aɪˈiːʃə", voice_model_version: "mock-voice-1" },
  expires: "session_end",
  predecessor: null,
};

describe("failure → evidence → repair → corrected next turn", () => {
  it("runs the full loop against the mock Evolve service", async () => {
    const { evolve, store, tts, controller } = setup();

    // Turn 1: seeded fault drops any pronunciation handling for the entity.
    controller.injector.arm("demo-person-17");
    const turn1 = await controller.runTurn(ayeshaBrain);
    expect(turn1.status).toBe("delivered");
    expect(turn1.evidence.injected_fault).toBe("seeded-pronunciation-drop");
    expect(tts.rendered[0]).toBe("Welcome back, Ayesha! How can I help?"); // plain text = mispronounced
    await flush();
    expect(evolve.evidenceCount()).toBe(1);

    // Evolve (Part B, mocked) diagnoses and releases a scoped repair.
    const overlay = evolve.releaseRepair("s-42", repair);
    // The seeded adapter fault is what we are repairing; the repair lands with it fixed.
    controller.injector.disarm();
    expect(store.stage(overlay)).toBe(true);

    // Turn 2: the repair is active for the next eligible utterance.
    const turn2 = await controller.runTurn(ayeshaBrain);
    expect(turn2.status).toBe("delivered");
    expect(turn2.utterance!.effectiveVersion).toBe("base-1+overlay.1");
    expect(tts.rendered[1]).toBe("Welcome back, [aɪˈiːʃə]! How can I help?");
    // Display text is unchanged for the UI.
    expect(turn2.evidence.intended_text).toBe("Welcome back, Ayesha! How can I help?");
  });

  it("negative control: the repair does not touch an unrelated entity", async () => {
    const { evolve, store, tts, controller } = setup();
    store.stage(evolve.releaseRepair("s-42", repair));

    const turn = await controller.runTurn(async () => ({
      intendedText: "Asia is the largest continent.",
      entities: [{ entity_id: "continent-asia", surface: "Asia" }],
    }));
    expect(turn.status).toBe("delivered");
    expect(tts.rendered[0]).toBe("Asia is the largest continent.");
  });

  it("a mid-generation repair release does not change the running turn's version", async () => {
    const { evolve, store, controller } = setup();

    let releaseDuringBrain: () => void = () => {};
    const slowBrain = () =>
      new Promise<Awaited<ReturnType<typeof ayeshaBrain>>>((resolve) => {
        releaseDuringBrain = () => {
          store.stage(evolve.releaseRepair("s-42", repair));
          resolve({
            intendedText: "Hello Ayesha",
            entities: [{ entity_id: "demo-person-17", surface: "Ayesha" }],
          });
        };
        setTimeout(() => releaseDuringBrain(), 0);
      });

    const turn = await controller.runTurn(slowBrain);
    // The overlay arrived mid-turn: this turn stays pinned to overlay.0 …
    expect(turn.utterance!.effectiveVersion).toBe("base-1+overlay.0");
    // … and the next turn picks it up at the boundary.
    const next = await controller.runTurn(ayeshaBrain);
    expect(next.utterance!.effectiveVersion).toBe("base-1+overlay.1");
  });

  it("an interrupted turn is superseded and never delivered", async () => {
    const { controller, sink } = setup();

    const turnPromise = controller.runTurn(async () => {
      controller.interrupt(); // user barges in while the brain is thinking
      return ayeshaBrain();
    });
    const result = await turnPromise;
    expect(result.status).toBe("superseded");
    expect(result.utterance).toBeUndefined();
    await flush();
    expect(sink.posted[0]!.delivery_events.map((e) => e.type)).toContain("superseded");
  });

  it("evidence posting failure does not break the turn", async () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    const failingSink: EvidenceSink = {
      post: async () => {
        throw new Error("evolve is down");
      },
    };
    const controller = new TurnController("demo", "s-42", store, new MockTTSEngine(), failingSink);
    const turn = await controller.runTurn(ayeshaBrain);
    await flush();
    expect(turn.status).toBe("delivered");
  });

  it("duplicate evidence posts are idempotent at the mock service", async () => {
    const { evolve, controller } = setup();
    const turn = await controller.runTurn(ayeshaBrain);
    await flush();
    evolve.receiveEvidence(turn.evidence); // retry of the same utterance
    expect(evolve.evidenceCount()).toBe(1);
  });
});
