// The Part B deliverable checkpoint (WORK-SPLIT.md):
//
//   "given a mocked incident payload, the full loop runs — diagnosis, two
//    candidates, verifier rejection of the bad one, gate release, three real
//    app records."
//
// Everything here runs offline against deterministic providers. What that
// proves is that the ORCHESTRATION is correct. It does not prove a model
// diagnoses well or that real audio was judged — those claims need the live
// providers, and the eval report states which mode produced its numbers.

import { describe, expect, it } from "vitest";
import {
  AISHA,
  AYESHA,
  BASE_VERSION,
  DEFAULT_G2P,
  SESSION,
  TENANT,
  buildWorld,
  makeTurn,
} from "../src/scenario.ts";
import { verifyArtifact } from "../src/domain/artifact.ts";
import { recordingFetch } from "./helpers.ts";

/** The failing turn: correct display text, no pronunciation override applied. */
function failingTurn() {
  return makeTurn({
    turnId: "t-1",
    intendedText: "Good morning Ayesha, your order is ready.",
    entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
    applied: {}, // the seeded fault dropped the override
    transcript: "good morning this is Ayesha",
    injectedFault: "seeded-pronunciation-drop",
  });
}

describe("Evolve end-to-end repair loop", () => {
  it("detects, diagnoses, rejects the harmful candidate, releases the good one, and records it", async () => {
    const rec = recordingFetch();
    const world = buildWorld({ offline: true, forceApps: true, appFetch: rec.fetch });

    /* --- 1. Evidence in -> incident opened ------------------------------ */
    const ingest = await world.orchestrator.ingest(failingTurn());

    expect(ingest.accepted).toBe(true);
    expect(ingest.duplicate).toBe(false);

    const pronunciationIncidents = ingest.incidents.filter((i) => i.layer === "pronunciation");
    expect(pronunciationIncidents).toHaveLength(1);

    const incident = pronunciationIncidents[0]!;
    expect(incident.entity_id).toBe(AYESHA.entity_id);
    expect(incident.injected_fault).toBe("seeded-pronunciation-drop");
    expect(incident.observed_version).toBe(BASE_VERSION + "+overlay.0");

    /* --- 2. The repair loop -------------------------------------------- */
    const outcome = await world.orchestrator.runRepairLoop(incident);

    // Specialists each reported, and only speech localized to pronunciation.
    expect(outcome.findings.map((f) => f.specialist).sort()).toEqual([
      "memory",
      "perception",
      "speech",
    ]);
    const speech = outcome.findings.find((f) => f.specialist === "speech")!;
    expect(speech.layer).toBe("pronunciation");

    // Perception must NOT claim a recognition fault here — plan §12 step 3.
    const perception = outcome.findings.find((f) => f.specialist === "perception")!;
    expect(perception.layer).not.toBe("recognition");

    /* --- 3. Two candidates, one refuted -------------------------------- */
    expect(outcome.candidates.length).toBeGreaterThanOrEqual(1);
    expect(outcome.candidates.length).toBeLessThanOrEqual(2);

    /* --- 4. Gate released the survivor --------------------------------- */
    expect(outcome.gate).not.toBeNull();
    expect(outcome.gate!.released).toBe(true);
    expect(outcome.gate!.conditions).toHaveLength(6);
    expect(outcome.gate!.conditions.every((c) => c.passed)).toBe(true);

    expect(outcome.artifact).not.toBeNull();
    const artifact = outcome.artifact!;
    expect(verifyArtifact(artifact)).toBe(true);
    expect(artifact.repair.payload).toMatchObject({ phonemes: AYESHA.reference_phonemes });

    // A measured latency, not a promised one (plan §14).
    expect(outcome.detectionToActivationMs).toBeGreaterThan(0);

    /* --- 5. Contract 2 now serves the repair --------------------------- */
    const overlay = world.overlays.serve(SESSION);
    expect(overlay.overlay_version).toBe(1);
    expect(overlay.repairs).toHaveLength(1);
    expect(overlay.repairs[0]!.scope.entity_id).toBe(AYESHA.entity_id);
    expect(overlay.repairs[0]!.expires).toBe("session_end");

    /* --- 6. Three real app records ------------------------------------- */
    await world.queue.drain();

    const sentry = rec.byApp("sentry");
    const slack = rec.byApp("slack");
    const github = rec.byApp("github");

    expect(sentry.length).toBeGreaterThan(0);
    expect(slack.length).toBeGreaterThan(0);
    expect(github.length).toBeGreaterThan(0);

    // Sentry: fingerprinted on the incident id so retries converge.
    const opened = sentry.find((r) => r.url.includes("/store/"))!;
    expect(opened.body).toMatchObject({ fingerprint: [incident.incident_id] });

    // GitHub: the manifest carries the artifact hash and the fixture results.
    const commit = github.find((r) => r.method === "PUT")!;
    const manifest = JSON.parse(
      Buffer.from((commit.body as { content: string }).content, "base64").toString("utf8"),
    );
    expect(manifest.repair_id).toBe(artifact.repair_id);
    expect(manifest.artifact_hash).toBe(artifact.artifact_hash);
    expect(manifest.evaluation.length).toBe(outcome.candidates.length);
    // The commit must land outside the protected fixture path.
    expect(commit.url).toContain("/contents/repairs/");
    expect(commit.url).not.toContain("fixtures/");
  });

  it("rejects the candidate that would make two registered people sound identical", async () => {
    const world = buildWorld({ offline: true });
    const ingest = await world.orchestrator.ingest(failingTurn());
    const incident = ingest.incidents.find((i) => i.layer === "pronunciation")!;
    const outcome = await world.orchestrator.runRepairLoop(incident);

    // The harmful candidate proposes Aisha's pronunciation for Ayesha.
    const harmful = outcome.candidates.find(
      (c) => (c.payload as { phonemes?: string }).phonemes === AISHA.reference_phonemes,
    );
    expect(harmful, "scenario should offer the neighbour-collision candidate").toBeDefined();

    const verdict = outcome.verdicts.find((v) => v.candidate_id === harmful!.candidate_id)!;
    expect(verdict.refuted).toBe(true);
    expect(verdict.counterexamples.length).toBeGreaterThan(0);

    // It must not be what got released.
    expect(outcome.decision.chosen_candidate_id).not.toBe(harmful!.candidate_id);
    expect(outcome.decision.rejected_candidate_ids).toContain(harmful!.candidate_id);
  });

  it("verifies the repair on a genuinely new sentence and resolves the incident", async () => {
    const rec = recordingFetch();
    const world = buildWorld({ offline: true, forceApps: true, appFetch: rec.fetch });

    const ingest = await world.orchestrator.ingest(failingTurn());
    const incident = ingest.incidents.find((i) => i.layer === "pronunciation")!;
    const outcome = await world.orchestrator.runRepairLoop(incident);
    const repair = outcome.artifact!.repair;

    // A sentence never used during candidate generation (plan §6C).
    const fresh = makeTurn({
      turnId: "t-2",
      intendedText: "Ayesha, I have updated your delivery address.",
      entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
      applied: { [AYESHA.entity_id]: (repair.payload as { phonemes: string }).phonemes },
      overlayVersion: 1,
    });

    const second = await world.orchestrator.ingest(fresh);

    expect(second.observations).toHaveLength(1);
    expect(second.observations[0]!.verified).toBe(true);
    expect(second.observations[0]!.rolledBack).toBe(false);

    expect(world.store.getIncident(incident.incident_id)!.status).toBe("resolved");

    // Sentry saw the resolve transition.
    await world.queue.drain();
    const resolves = rec
      .byApp("sentry")
      .filter((r) => r.method === "PUT" && (r.body as { status?: string }).status === "resolved");
    expect(resolves.length).toBe(1);
    expect(resolves[0]!.url).toContain(encodeURIComponent("incident_id:" + incident.incident_id));
  });

  it("rolls back — to a HIGHER overlay version — when a repaired utterance regresses", async () => {
    const rec = recordingFetch();
    const world = buildWorld({ offline: true, forceApps: true, appFetch: rec.fetch });

    const ingest = await world.orchestrator.ingest(failingTurn());
    const incident = ingest.incidents.find((i) => i.layer === "pronunciation")!;
    const outcome = await world.orchestrator.runRepairLoop(incident);
    const repairId = outcome.artifact!.repair_id;

    expect(world.overlays.overlayVersion(SESSION)).toBe(1);

    // The runtime applied the override but the audio came out wrong anyway —
    // e.g. the voice model changed underneath us.
    const regressed = makeTurn({
      turnId: "t-3",
      intendedText: "Ayesha, your appointment is confirmed.",
      entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
      applied: { [AYESHA.entity_id]: "/totally-wrong/" },
      overlayVersion: 1,
    });

    const result = await world.orchestrator.ingest(regressed);

    expect(result.observations[0]!.rolledBack).toBe(true);
    expect(world.store.getIncident(incident.incident_id)!.status).toBe("rolled_back");

    // The crucial detail: Part A ignores any overlay that does not ADVANCE the
    // counter, so a rollback has to move forward, not back.
    expect(world.overlays.overlayVersion(SESSION)).toBe(2);
    expect(world.overlays.serve(SESSION).repairs).toHaveLength(0);

    // The entity is quarantined rather than silently re-repaired.
    expect(world.registry.get(TENANT, AYESHA.entity_id)!.status).toBe("quarantined");

    await world.queue.drain();
    const reopens = rec
      .byApp("sentry")
      .filter((r) => r.method === "PUT" && (r.body as { status?: string }).status === "unresolved");
    expect(reopens.length).toBe(1);

    void repairId;
  });

  it("is idempotent: the same evidence posted twice opens one incident", async () => {
    const world = buildWorld({ offline: true });
    const first = await world.orchestrator.ingest(failingTurn());
    const second = await world.orchestrator.ingest(failingTurn());

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.incidents).toHaveLength(0);
    expect(world.store.listIncidents().filter((i) => i.layer === "pronunciation")).toHaveLength(1);
  });

  it("keeps working when an external app is down", async () => {
    // Plan §11: "A Slack failure does not prevent an already verified session correction."
    const rec = recordingFetch({ failFor: (url) => url.includes("slack.com") });
    const world = buildWorld({ offline: true, forceApps: true, appFetch: rec.fetch });

    const ingest = await world.orchestrator.ingest(failingTurn());
    const incident = ingest.incidents.find((i) => i.layer === "pronunciation")!;
    const outcome = await world.orchestrator.runRepairLoop(incident);

    expect(outcome.gate!.released).toBe(true);
    expect(world.overlays.serve(SESSION).repairs).toHaveLength(1);

    const results = await world.queue.drain();
    expect(results.some((r) => r.app === "slack" && r.status === "failed")).toBe(true);
    expect(results.some((r) => r.app === "github" && r.status === "ok")).toBe(true);
  });

  it("abstains for an entity with no reference recording", async () => {
    // Plan §2: without trustworthy reference evidence the honest move is to
    // abstain, not to invent a pronunciation.
    const world = buildWorld({ offline: true });
    const turn = makeTurn({
      turnId: "t-9",
      intendedText: "Please confirm with Khadija before we proceed.",
      entities: [{ entity_id: "demo-person-31", surface: "Khadija" }],
      applied: {},
    });

    const ingest = await world.orchestrator.ingest(turn);
    expect(ingest.incidents.filter((i) => i.layer === "pronunciation")).toHaveLength(0);
  });

  it("does not repair 'Asia' — the negative control", async () => {
    // Plan §6A / §12: the apparent mistaken word is actually correct here.
    const world = buildWorld({ offline: true });
    const turn = makeTurn({
      turnId: "t-10",
      intendedText: "Our Asia team will follow up tomorrow.",
      entities: [],
      applied: {},
      transcript: "how is the Asia team doing",
    });

    const ingest = await world.orchestrator.ingest(turn);
    expect(ingest.incidents).toHaveLength(0);
    expect(DEFAULT_G2P["Asia"]).toBe("/ˈeɪʒə/");
  });
});
