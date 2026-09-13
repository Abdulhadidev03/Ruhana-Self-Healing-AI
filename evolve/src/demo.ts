// The demonstration of plan §12, narrated.
//
//   node --run evolve:demo          deterministic providers, no network
//   node --run evolve:demo -- --live  real models from .env
//
// The narration reports what actually happened. Where a step could not be run
// for real, it says so rather than printing the line it would have printed.

import { AYESHA, AISHA, SESSION, TENANT, buildWorld, makeTurn } from "./scenario.ts";
import { loadEnv, describeCapabilities } from "./util/env.ts";
import { verifyArtifact } from "./domain/artifact.ts";
import { displayName } from "./apps/connectors.ts";

const live = process.argv.includes("--live");
const NEWLINE = "\n";
const env = loadEnv();

function h(title: string): void {
  console.log("\n" + "─".repeat(74));
  console.log(title);
  console.log("─".repeat(74));
}

function bullet(label: string, value: string): void {
  console.log("  " + label.padEnd(26) + value);
}

async function main(): Promise<void> {
  const world = buildWorld({ offline: !live, env, forceApps: false });

  h("Ruhana Evolve — autonomous repair demonstration (plan §12)");
  bullet("mode", live ? "LIVE (real model providers)" : "deterministic (no network)");
  bullet("specialist model", world.llm.name);
  bullet("supervisor model", world.supervisorName);
  bullet("acoustic judge", world.judge.name + (world.live.judge ? "" : "  [stand-in: not audio analysis]"));
  bullet("renderer", world.renderer.name + (world.live.renderer ? "" : "  [stand-in: simulated G2P]"));
  bullet("external apps", describeCapabilities(env));

  /* ---------------------------------------------------------------- */
  h("1. The avatar speaks. Display text correct, pronunciation wrong.");

  const failing = makeTurn({
    turnId: "t-1",
    intendedText: "Good morning Ayesha, your order is ready.",
    entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
    applied: {}, // the seeded fault dropped the pronunciation override
    transcript: "good morning this is Ayesha",
    injectedFault: "seeded-pronunciation-drop",
  });

  bullet("intended text", JSON.stringify(failing.intended_text));
  bullet("reference pronunciation", AYESHA.reference_phonemes);
  bullet("seeded fault", failing.injected_fault ?? "none");
  bullet("speech submitted", JSON.stringify(failing.speech_input));

  const ingest = await world.orchestrator.ingest(failing);
  const incident = ingest.incidents.find((i) => i.layer === "pronunciation");

  if (!incident) {
    console.log("\n  No pronunciation incident was detected. Demo cannot continue.");
    process.exit(1);
  }

  bullet("incident opened", incident.incident_id);
  bullet("suspected layer", incident.layer);
  bullet("observed version", incident.observed_version);

  /* ---------------------------------------------------------------- */
  h("2. Specialists inspect their own evidence, independently.");

  const started = Date.now();
  const outcome = await world.orchestrator.runRepairLoop(incident);
  const wallClockMs = Date.now() - started;

  for (const f of outcome.findings) {
    console.log("\n  " + f.specialist.toUpperCase() + "  [" + f.layer + "]  confidence " + f.confidence.toFixed(2));
    console.log("    " + f.hypothesis);
    console.log("    disproved by: " + f.disconfirming_condition);
  }

  /* ---------------------------------------------------------------- */
  h("2b. The challenge round — specialists read each other (plan §4 step 2).");

  if (outcome.discussion.length === 0) {
    console.log("  No challenge round ran for this incident.");
  } else {
    // Same names Slack shows, so the console transcript and the thread match.
    const face = (role: string) => displayName(role).padEnd(20);
    for (const m of outcome.discussion) {
      const at = m.to === "all" ? "" : " -> " + displayName(m.to);
      console.log(
        NEWLINE + "  " + face(m.from) + at + "  [" + m.stance + "]",
      );
      console.log("    " + m.text);
      if (m.references.length > 0) console.log("    cites: " + m.references.join(", "));
    }
    console.log(
      NEWLINE +
        (world.live.llm
          ? "  (Above are the models' actual replies, generated just now.)"
          : "  (Above are SCRIPTED stand-ins — this run has no model behind it." +
            NEWLINE +
            "   Run with --live for a real exchange.)") +
        NEWLINE +
        "  Nothing here reaches the gate: plan §1, agreement is not a release criterion.",
    );
  }

  /* ---------------------------------------------------------------- */
  h("3. Candidate experiments — generated, then measured.");

  for (const c of outcome.candidates) {
    const v = outcome.verdicts.find((x) => x.candidate_id === c.candidate_id);
    console.log("\n  " + c.candidate_id + "  " + JSON.stringify(c.payload));
    console.log("    rationale: " + c.rationale);
    console.log("    verifier:  " + (v?.refuted ? "REFUTED — " : "survived — ") + (v?.reason ?? "n/a"));
    if (v?.acoustic) {
      console.log(
        "    acoustic:  score " + v.acoustic.match_score.toFixed(2) + " (" + v.acoustic.judge_model + ")",
      );
    }
    for (const fx of v?.fixture_results ?? []) {
      console.log(
        "      " +
          (fx.passed ? "PASS " : "FAIL ") +
          fx.fixture_id.padEnd(26) +
          (fx.negative_control ? "[negative control] " : "") +
          fx.detail.slice(0, 90),
      );
    }
  }

  /* ---------------------------------------------------------------- */
  h("4. Supervisor decision and the machine release gate.");

  bullet("action", outcome.decision.action);
  bullet("chosen", outcome.decision.chosen_candidate_id ?? "none");
  bullet("rejected", outcome.decision.rejected_candidate_ids.join(", ") || "none");
  console.log("  rationale: " + outcome.decision.rationale);
  if (outcome.supervisorOverrode) {
    console.log("  NOTE: code overrode the supervisor — " + outcome.supervisorOverrode);
  }

  if (outcome.gate) {
    console.log("");
    for (const c of outcome.gate.conditions) {
      console.log("    " + (c.passed ? "PASS " : "FAIL ") + ("condition " + c.id).padEnd(13) + c.name.padEnd(32) + c.detail.slice(0, 70));
    }
    console.log("\n  gate: " + (outcome.gate.released ? "RELEASED" : "BLOCKED — " + outcome.gate.blockedBy));
  }

  if (!outcome.artifact) {
    console.log("\n  No repair released. This is a valid outcome — automatic restraint.");
    await world.queue.drain();
    return;
  }

  const artifact = outcome.artifact;
  bullet("\n  repair id", artifact.repair_id);
  bullet("  artifact hash", artifact.artifact_hash.slice(0, 32) + "…");
  bullet("  integrity check", verifyArtifact(artifact) ? "valid" : "FAILED");
  bullet("  overlay version", String(artifact.overlay_version));
  bullet("  scope", JSON.stringify(artifact.repair.scope));
  bullet("  expires", artifact.repair.expires);

  /* ---------------------------------------------------------------- */
  h("5. A genuinely new sentence, spoken under the repair.");

  const phonemes = (artifact.repair.payload as { phonemes: string }).phonemes;
  const fresh = makeTurn({
    turnId: "t-2",
    intendedText: "Ayesha, I have updated your delivery address.",
    entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
    applied: { [AYESHA.entity_id]: phonemes },
    overlayVersion: artifact.overlay_version,
  });

  bullet("new sentence", JSON.stringify(fresh.intended_text));
  bullet("effective version", fresh.effective_version);

  const second = await world.orchestrator.ingest(fresh);
  for (const o of second.observations) {
    console.log("  " + (o.verified ? "VERIFIED  " : "NOT VERIFIED  ") + o.detail);
  }
  bullet("incident status", world.store.getIncident(incident.incident_id)!.status);

  /* ---------------------------------------------------------------- */
  h("6. Rollback proof — a regression on a live repaired utterance.");

  const regressed = makeTurn({
    turnId: "t-3",
    intendedText: "Ayesha, your appointment is confirmed.",
    entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
    applied: { [AYESHA.entity_id]: "/regressed-voice-model/" },
    overlayVersion: world.overlays.overlayVersion(SESSION),
  });

  const third = await world.orchestrator.ingest(regressed);
  for (const o of third.observations) {
    console.log("  " + (o.rolledBack ? "ROLLED BACK  " : "") + o.detail);
  }
  bullet("overlay now", String(world.overlays.overlayVersion(SESSION)));
  bullet("repairs active", String(world.overlays.serve(SESSION).repairs.length));
  bullet("entity status", world.registry.get(TENANT, AYESHA.entity_id)!.status);
  console.log("  (Rollback ADVANCES the overlay version — the runtime ignores any overlay");
  console.log("   that does not move the counter forward.)");

  /* ---------------------------------------------------------------- */
  h("7. Durable records and measured cost.");

  const writes = await world.queue.drain();
  if (writes.length === 0) {
    console.log("  No external app connectors configured, so no records were written.");
    console.log("  Set SENTRY_*, SLACK_* and GITHUB_* in .env to produce real records.");
  } else {
    for (const w of writes) {
      console.log("    " + w.status.padEnd(18) + w.app.padEnd(8) + w.description + (w.error ? "  (" + w.error + ")" : ""));
    }
  }

  const slack = world.apps.slack;
  if (slack && slack.customizeWorks === false) {
    console.log("");
    console.log("  NOTE: Slack dropped the per-agent username override, so every message");
    console.log("  posted as the same bot with the speaker's name in bold instead. Add the");
    console.log("  chat:write.customize bot scope and reinstall the app for real per-agent");
    console.log("  names and avatars in the thread.");
  }

  console.log("");
  bullet("detection -> activation", outcome.detectionToActivationMs + " ms (injected clock)");
  bullet("wall clock for step 2-4", wallClockMs + " ms");
  bullet("LLM calls", String(outcome.usage.llmCalls));
  bullet("renders", String(outcome.usage.renders));
  bullet("acoustic judgements", String(outcome.usage.judgements));

  if (!world.live.judge || !world.live.renderer) {
    console.log("");
    console.log("  This run used deterministic stand-ins for the renderer and/or judge.");
    console.log("  It demonstrates the orchestration, not that real audio was assessed.");
  }

  void AISHA;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
