// M1 — contract round trip (WORK-SPLIT.md: "schemas committed, both mocks
// passing a shared round-trip test").
//
// This goes one better than mock-to-mock: it drives Part A's REAL client classes
// (HttpEvidenceSink, RepairsClient, SessionOverlayStore) against Part B's REAL
// HTTP server over a real socket. If the two halves disagree about a field name,
// a status code or the overlay-advance rule, it fails here rather than at
// wire-up.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { HttpEvidenceSink } from "../../runtime/src/evidence.ts";
import { RepairsClient } from "../../runtime/src/repairs-client.ts";
import { SessionOverlayStore } from "../../runtime/src/overlay.ts";
import { buildSpeechInput } from "../../runtime/src/speech-input.ts";

import { createEvolveServer } from "../src/api/server.ts";
import { AYESHA, BASE_VERSION, SESSION, TENANT, buildWorld, makeTurn } from "../src/scenario.ts";
import type { World } from "../src/scenario.ts";

let server: Server;
let baseUrl: string;
let world: World;

beforeAll(async () => {
  world = buildWorld({ offline: true });
  server = createEvolveServer(world);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = "http://127.0.0.1:" + addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Wait for the background repair loop to publish an overlay. */
async function waitForOverlay(minVersion: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (world.overlays.overlayVersion(SESSION) >= minVersion) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    "overlay did not reach version " + minVersion + " (still " + world.overlays.overlayVersion(SESSION) + ")",
  );
}

describe("contract round trip: Part A client <-> Part B server", () => {
  it("contract 2 serves the empty overlay for an unknown session", async () => {
    const res = await fetch(baseUrl + "/api/session/never-seen/repairs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session_id: "never-seen",
      overlay_version: 0,
      repairs: [],
    });
  });

  it("contract 1 accepts evidence from Part A's real HttpEvidenceSink", async () => {
    const sink = new HttpEvidenceSink(baseUrl);
    // Resolves only on a 2xx, so this asserts the status code too.
    await expect(
      sink.post(
        makeTurn({
          turnId: "t-1",
          intendedText: "Good morning Ayesha, your order is ready.",
          entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
          applied: {},
          injectedFault: "seeded-pronunciation-drop",
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a malformed payload with 400 rather than storing it", async () => {
    const res = await fetch(baseUrl + "/api/evidence/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: "demo" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).accepted).toBe(false);
  });

  it("the repair reaches Part A through its real RepairsClient and overlay store", async () => {
    // The background loop opened by the POST above should release a repair.
    await waitForOverlay(1);

    const store = new SessionOverlayStore(BASE_VERSION, TENANT, SESSION);
    const client = new RepairsClient(baseUrl, SESSION, store);

    const staged = await client.pollOnce();
    expect(staged, "Part A's store should accept the overlay").toBe(true);

    // Staged is not yet active: Part A only activates at a turn boundary.
    expect(store.snapshot().overlayVersion).toBe(0);
    expect(store.applyAtTurnBoundary()).toBe(true);

    const snapshot = store.snapshot();
    expect(snapshot.overlayVersion).toBe(1);
    expect(snapshot.effectiveVersion).toBe(BASE_VERSION + "+overlay.1");

    // Scope enforcement, using Part A's own filter.
    const forEntity = store.repairsForEntity(snapshot, AYESHA.entity_id);
    expect(forEntity).toHaveLength(1);
    expect(forEntity[0]!.type).toBe("pronunciation");

    // And the repair actually drives Part A's speech-input builder.
    const segments = buildSpeechInput(
      "Ayesha, your appointment is confirmed.",
      [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
      forEntity,
    );
    const phoneme = segments.find((s) => s.kind === "phoneme");
    expect(phoneme, "the released repair must produce a phoneme segment").toBeDefined();
    expect(phoneme && phoneme.kind === "phoneme" ? phoneme.phonemes : null).toBe(
      AYESHA.reference_phonemes,
    );

    // Display text is untouched (plan §6C).
    expect(segments.map((s) => (s.kind === "text" ? s.text : s.display)).join("")).toBe(
      "Ayesha, your appointment is confirmed.",
    );
  });

  it("a second poll with no new release does not re-stage", async () => {
    const store = new SessionOverlayStore(BASE_VERSION, TENANT, SESSION);
    const client = new RepairsClient(baseUrl, SESSION, store);

    expect(await client.pollOnce()).toBe(true);
    store.applyAtTurnBoundary();
    // Same overlay version -> Part A's store must reject it.
    expect(await client.pollOnce()).toBe(false);
  });

  it("duplicate evidence is reported as a duplicate, not stored twice", async () => {
    const turn = makeTurn({
      turnId: "t-dup",
      intendedText: "Hello there.",
      entities: [],
      applied: {},
    });

    const first = await fetch(baseUrl + "/api/evidence/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn),
    });
    const second = await fetch(baseUrl + "/api/evidence/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn),
    });

    expect(await first.json()).toEqual({ accepted: true, duplicate: false });
    expect(await second.json()).toEqual({ accepted: true, duplicate: true });
  });

  it("exposes a dashboard view with the artifact and provider labelling", async () => {
    const body = (await (await fetch(baseUrl + "/api/dashboard")).json()) as {
      incidents: { incident_id: string; layer: string; artifact: { artifact_hash: string } | null }[];
      providers: { llm: string; judge: string; renderer: string; live: Record<string, boolean> };
    };

    const pron = body.incidents.find((i) => i.layer === "pronunciation");
    expect(pron).toBeDefined();
    expect(pron!.artifact?.artifact_hash).toMatch(/^[0-9a-f]{64}$/);

    // The dashboard must say which providers actually produced the result, so a
    // deterministic run is never mistaken for a live one.
    expect(body.providers.live.llm).toBe(false);
    expect(body.providers.judge).toContain("fake");
  });
});
