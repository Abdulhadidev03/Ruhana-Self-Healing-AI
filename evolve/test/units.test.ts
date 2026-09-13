// Focused unit tests for the pieces the end-to-end run exercises but cannot
// isolate: detection, the verifier's structural invariants, overlay/rollback
// mechanics, artifact integrity, app-write idempotency and redaction.

import { describe, expect, it } from "vitest";
import { detect, editDistance } from "../src/domain/detection.ts";
import { hashRepair, issueArtifact, verifyArtifact } from "../src/domain/artifact.ts";
import { SessionOverlayRegistry } from "../src/domain/overlay-store.ts";
import { canonicalJson, incidentId, payloadHash } from "../src/domain/ids.ts";
import { AdversarialVerifier, loadFixtures } from "../src/agents/verifier.ts";
import { PhonemeMatchJudge } from "../src/providers/audio-judge.ts";
import { FakeRenderer } from "../src/providers/renderer.ts";
import { AppWriteQueue } from "../src/apps/queue.ts";
import { GithubConnector, parseDsn, redact } from "../src/apps/connectors.ts";
import type { Candidate, RepairArtifact } from "../src/domain/model.ts";
import type { Repair } from "../../contracts/types.ts";
import {
  AISHA,
  AYESHA,
  BASE_VERSION,
  DEFAULT_G2P,
  SESSION,
  TENANT,
  buildRegistry,
  fixturesPath,
  makeTurn,
} from "../src/scenario.ts";

/* ------------------------------------------------------------------ */

describe("detection", () => {
  const registry = buildRegistry();

  it("flags a pronunciation discrepancy when the override is missing", () => {
    const turn = makeTurn({
      turnId: "t-1",
      intendedText: "Good morning Ayesha, your order is ready.",
      entities: [{ entity_id: AYESHA.entity_id, surface: "Ayesha" }],
      applied: {},
    });
    const found = detect(turn, registry);
    expect(found.map((d) => d.layer)).toContain("pronunciation");
    const pron = found.find((d) => d.layer === "pronunciation")!;
    expect(pron.expected_phonemes).toBe(AYESHA.reference_phonemes);
    expect(pron.submitted_phonemes).toBeNull();
    // Detection only SUSPECTS; confirming is the specialists' job (plan §2).
    expect(pron.requires_confirmation).toBe(true);
  });

  it("flags a discrepancy when the submitted phonemes differ from the reference", () => {
    const turn = makeTurn({
      turnId: "t-2",
      intendedText: "Hello Ayesha.",
      entities: [{ entity_id: AYESHA.entity_id, surface: "Ayesha" }],
      applied: { [AYESHA.entity_id]: "/wrong/" },
    });
    const pron = detect(turn, registry).find((d) => d.layer === "pronunciation")!;
    expect(pron.submitted_phonemes).toBe("/wrong/");
  });

  it("stays silent when the correct override was applied", () => {
    const turn = makeTurn({
      turnId: "t-3",
      intendedText: "Hello Ayesha.",
      entities: [{ entity_id: AYESHA.entity_id, surface: "Ayesha" }],
      applied: { [AYESHA.entity_id]: AYESHA.reference_phonemes },
    });
    expect(detect(turn, registry).filter((d) => d.layer === "pronunciation")).toHaveLength(0);
  });

  it("abstains for an entity with no reference recording", () => {
    const turn = makeTurn({
      turnId: "t-4",
      intendedText: "Ask Khadija about it.",
      entities: [{ entity_id: "demo-person-31", surface: "Khadija" }],
      applied: {},
    });
    expect(detect(turn, registry).filter((d) => d.layer === "pronunciation")).toHaveLength(0);
  });

  it("does not treat 'Asia' as a mis-recognition of 'Ayesha'", () => {
    // The must_not_rewrite guard fires before any agent runs (plan §6A).
    const turn = makeTurn({
      turnId: "t-5",
      intendedText: "Our Asia team will follow up.",
      entities: [{ entity_id: AYESHA.entity_id, surface: "Ayesha" }],
      applied: {},
      transcript: "how is the Asia team",
    });
    expect(detect(turn, registry).filter((d) => d.layer === "recognition")).toHaveLength(0);
  });

  it("flags audio delivered after the turn was superseded", () => {
    const turn = makeTurn({ turnId: "t-6", intendedText: "Hello.", entities: [] });
    turn.delivery_events = [
      { type: "superseded", client_ts: 100 },
      { type: "playback_start", client_ts: 250 },
    ];
    const runtime = detect(turn, registry).find((d) => d.layer === "runtime");
    expect(runtime).toBeDefined();
    expect(runtime!.requires_confirmation).toBe(false);
  });

  it("flags duplicate playback", () => {
    const turn = makeTurn({ turnId: "t-7", intendedText: "Hello.", entities: [] });
    turn.delivery_events = [
      { type: "playback_start", client_ts: 10 },
      { type: "playback_start", client_ts: 20 },
    ];
    expect(detect(turn, registry).some((d) => d.layer === "runtime")).toBe(true);
  });

  it("editDistance behaves", () => {
    expect(editDistance("Ayesha", "Ayesha")).toBe(0);
    expect(editDistance("Ayesha", "Aisha")).toBeGreaterThan(0);
    expect(editDistance("", "abc")).toBe(3);
  });
});

/* ------------------------------------------------------------------ */

describe("verifier invariants", () => {
  const registry = buildRegistry();
  const fixtures = loadFixtures(fixturesPath());

  function verifier() {
    return new AdversarialVerifier(
      registry,
      new FakeRenderer(DEFAULT_G2P),
      new PhonemeMatchJudge(),
      fixtures,
    );
  }

  function candidate(phonemes: string): Candidate {
    return {
      candidate_id: "cand-test",
      incident_id: "inc-test",
      type: "pronunciation",
      payload: { phonemes, voice_model_version: "kokoro-82m/af_heart" },
      rationale: "test",
      audio: null,
      payload_hash: payloadHash({ phonemes }),
    };
  }

  it("cannot refute the candidate derived from the reference", async () => {
    const v = await verifier().verify(candidate(AYESHA.reference_phonemes), TENANT, AYESHA.entity_id);
    expect(v.refuted).toBe(false);
    expect(v.fixture_results.every((f) => f.passed)).toBe(true);
  });

  it("refutes a candidate that pronounces the target as a different registered person", async () => {
    const v = await verifier().verify(candidate(AISHA.reference_phonemes), TENANT, AYESHA.entity_id);
    expect(v.refuted).toBe(true);
    // The neighbour control is among the fixtures that caught it.
    expect(v.fixture_results.find((f) => f.fixture_id === "fx-negative-neighbour-05")!.passed).toBe(
      false,
    );
  });

  it("never fires on the 'Asia' negative control, whatever the candidate", async () => {
    for (const phonemes of [AYESHA.reference_phonemes, AISHA.reference_phonemes, "/anything/"]) {
      const v = await verifier().verify(candidate(phonemes), TENANT, AYESHA.entity_id);
      const asia = v.fixture_results.find((f) => f.fixture_id === "fx-negative-asia-04")!;
      expect(asia.passed, "Asia control must hold for " + phonemes).toBe(true);
      expect(asia.negative_control).toBe(true);
    }
  });

  it("runs every fixture, including the non-required ones", async () => {
    const v = await verifier().verify(candidate(AYESHA.reference_phonemes), TENANT, AYESHA.entity_id);
    expect(v.fixture_results).toHaveLength(fixtures.fixtures.length);
  });
});

/* ------------------------------------------------------------------ */

describe("session overlay and rollback", () => {
  function artifactFor(repairId: string, entityId: string, overlay: number): RepairArtifact {
    const repair: Repair = {
      repair_id: repairId,
      type: "pronunciation",
      scope: { tenant: TENANT, entity_id: entityId, session_id: SESSION },
      payload: { phonemes: "/x/", voice_model_version: "v1" },
      expires: "session_end",
      predecessor: null,
    };
    return issueArtifact({
      repair,
      incidentId: "inc-1",
      baseVersion: BASE_VERSION,
      overlayVersion: overlay,
      issuedAt: 100,
    });
  }

  it("serves the empty overlay for an unknown session", () => {
    const reg = new SessionOverlayRegistry(BASE_VERSION);
    const served = reg.serve("unknown");
    expect(served).toEqual({ session_id: "unknown", overlay_version: 0, repairs: [] });
  });

  it("advances the overlay version on release", () => {
    const reg = new SessionOverlayRegistry(BASE_VERSION);
    reg.release(SESSION, artifactFor("r-1", AYESHA.entity_id, 1));
    expect(reg.serve(SESSION).overlay_version).toBe(1);
    expect(reg.serve(SESSION).repairs).toHaveLength(1);
  });

  it("supersedes rather than accumulates repairs for the same entity and type", () => {
    const reg = new SessionOverlayRegistry(BASE_VERSION);
    reg.release(SESSION, artifactFor("r-1", AYESHA.entity_id, 1));
    reg.release(SESSION, artifactFor("r-2", AYESHA.entity_id, 2));
    const served = reg.serve(SESSION);
    expect(served.repairs).toHaveLength(1);
    expect(served.repairs[0]!.repair_id).toBe("r-2");
    expect(served.overlay_version).toBe(2);
  });

  it("keeps repairs for different entities side by side", () => {
    const reg = new SessionOverlayRegistry(BASE_VERSION);
    reg.release(SESSION, artifactFor("r-1", AYESHA.entity_id, 1));
    reg.release(SESSION, artifactFor("r-2", AISHA.entity_id, 2));
    expect(reg.serve(SESSION).repairs).toHaveLength(2);
  });

  it("rolls back by ADVANCING the version, because the runtime ignores non-advancing overlays", () => {
    const reg = new SessionOverlayRegistry(BASE_VERSION);
    reg.release(SESSION, artifactFor("r-1", AYESHA.entity_id, 1));
    const after = reg.rollback(SESSION, "r-1")!;
    expect(after.overlay_version).toBe(2); // higher, not lower
    expect(after.repairs).toHaveLength(0);
  });

  it("treats a duplicate rollback as a no-op rather than an empty version bump", () => {
    const reg = new SessionOverlayRegistry(BASE_VERSION);
    reg.release(SESSION, artifactFor("r-1", AYESHA.entity_id, 1));
    expect(reg.rollback(SESSION, "r-1")).not.toBeNull();
    expect(reg.rollback(SESSION, "r-1")).toBeNull();
    expect(reg.overlayVersion(SESSION)).toBe(2);
  });
});

/* ------------------------------------------------------------------ */

describe("repair artifacts", () => {
  const repair: Repair = {
    repair_id: "r-1",
    type: "pronunciation",
    scope: { tenant: TENANT, entity_id: AYESHA.entity_id, session_id: SESSION },
    payload: { phonemes: AYESHA.reference_phonemes, voice_model_version: "v1" },
    expires: "session_end",
    predecessor: null,
  };

  it("verifies an untampered artifact", () => {
    const a = issueArtifact({ repair, incidentId: "inc-1", baseVersion: "base-1", overlayVersion: 1, issuedAt: 1 });
    expect(verifyArtifact(a)).toBe(true);
  });

  it("detects a tampered payload", () => {
    const a = issueArtifact({ repair, incidentId: "inc-1", baseVersion: "base-1", overlayVersion: 1, issuedAt: 1 });
    const tampered: RepairArtifact = {
      ...a,
      repair: { ...a.repair, payload: { phonemes: "/evil/", voice_model_version: "v1" } },
    };
    expect(verifyArtifact(tampered)).toBe(false);
  });

  it("binds the hash to the version it was released into", () => {
    expect(hashRepair(repair, "base-1", 1)).not.toBe(hashRepair(repair, "base-1", 2));
    expect(hashRepair(repair, "base-1", 1)).not.toBe(hashRepair(repair, "base-2", 1));
  });

  it("hashes independently of key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("derives the same incident id for the same failure", () => {
    expect(incidentId("demo", "s-42", "pronunciation", "e-1")).toBe(
      incidentId("demo", "s-42", "pronunciation", "e-1"),
    );
    expect(incidentId("demo", "s-42", "pronunciation", "e-1")).not.toBe(
      incidentId("demo", "s-42", "recognition", "e-1"),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("external app writes", () => {
  it("runs a job once per idempotency key", async () => {
    const queue = new AppWriteQueue(3, async () => {});
    let runs = 0;
    const job = { key: "k-1", app: "slack" as const, description: "post", run: async () => ++runs };
    queue.enqueue(job);
    queue.enqueue(job);
    const results = await queue.drain();
    expect(runs).toBe(1);
    expect(results.filter((r) => r.status === "skipped_duplicate")).toHaveLength(1);
  });

  it("retries then records a failure without throwing", async () => {
    const queue = new AppWriteQueue(3, async () => {});
    queue.enqueue({
      key: "k-2",
      app: "sentry",
      description: "open",
      run: async () => {
        throw new Error("boom");
      },
    });
    const results = await queue.drain();
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.attempts).toBe(3);
  });

  it("succeeds on a later attempt", async () => {
    const queue = new AppWriteQueue(3, async () => {});
    let n = 0;
    queue.enqueue({
      key: "k-3",
      app: "github",
      description: "commit",
      run: async () => {
        if (++n < 3) throw new Error("flaky");
        return "ok";
      },
    });
    const results = await queue.drain();
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.attempts).toBe(3);
  });

  it("runs same-stream jobs strictly in order", async () => {
    // Regression: resolve and reopen raced, and the issue was left in whichever
    // state finished last. Observed live — a rolled-back repair showed as
    // resolved in Sentry.
    const queue = new AppWriteQueue(3, async () => {});
    const order: string[] = [];
    const job = (name: string, delay: number) => ({
      key: "k-" + name,
      app: "sentry" as const,
      description: name,
      stream: "sentry:inc-1",
      run: async () => {
        await new Promise((r) => setTimeout(r, delay));
        order.push(name);
        return name;
      },
    });

    // Enqueued slowest-first: without stream ordering these finish reversed.
    queue.enqueue(job("open", 30));
    queue.enqueue(job("resolve", 20));
    queue.enqueue(job("reopen", 1));

    await queue.drain();
    expect(order).toEqual(["open", "resolve", "reopen"]);
  });

  it("still runs different streams concurrently", async () => {
    const queue = new AppWriteQueue(3, async () => {});
    const order: string[] = [];
    const job = (name: string, stream: string, delay: number) => ({
      key: "k2-" + name,
      app: "slack" as const,
      description: name,
      stream,
      run: async () => {
        await new Promise((r) => setTimeout(r, delay));
        order.push(name);
      },
    });

    queue.enqueue(job("slow-a", "s:a", 40));
    queue.enqueue(job("fast-b", "s:b", 1));

    await queue.drain();
    // Different incidents must not serialize behind each other.
    expect(order).toEqual(["fast-b", "slow-a"]);
  });

  it("a failing job does not stall the rest of its stream", async () => {
    const queue = new AppWriteQueue(2, async () => {});
    const order: string[] = [];
    queue.enqueue({
      key: "k3-bad",
      app: "sentry",
      description: "bad",
      stream: "s:x",
      run: async () => {
        order.push("bad");
        throw new Error("boom");
      },
    });
    queue.enqueue({
      key: "k3-good",
      app: "sentry",
      description: "good",
      stream: "s:x",
      run: async () => {
        order.push("good");
      },
    });

    const results = await queue.drain();
    // "bad" appears twice: it exhausts its retries first. The stream waits for
    // it to settle — which is the point, since the next write to the same
    // record must not overtake it — and then continues rather than stalling.
    expect(order).toEqual(["bad", "bad", "good"]);
    expect(results.find((r) => r.description === "bad")!.status).toBe("failed");
    expect(results.find((r) => r.description === "good")!.status).toBe("ok");
  });

  it("redacts personal names before they reach an external app", () => {
    const out = redact("Ayesha was mispronounced in session s-42", ["Ayesha"]);
    expect(out).not.toContain("Ayesha");
    expect(out).toContain("s-42");
  });

  it("refuses to write a repair manifest into a protected path", () => {
    const path = GithubConnector.manifestPath("inc-1", "r-1");
    expect(path.startsWith("repairs/")).toBe(true);
    expect(path).not.toContain("fixtures/");
    expect(path).not.toContain(".github/");
  });

  it("parses a Sentry DSN", () => {
    const parsed = parseDsn("https://abc123@o12345.ingest.sentry.io/98765");
    expect(parsed.publicKey).toBe("abc123");
    expect(parsed.projectId).toBe("98765");
    expect(parsed.endpoint).toContain("/api/98765/store/");
    expect(() => parseDsn("not-a-dsn")).toThrow();
  });
});
