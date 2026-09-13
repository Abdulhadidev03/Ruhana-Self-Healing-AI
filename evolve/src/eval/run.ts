// The evaluation suite (plan §14).
//
// Expected outcomes are decided HERE, before any candidate is generated, and the
// scenarios are labelled. Plan §14: "No score should appear before execution",
// and equally, no expectation may be edited afterwards to make a run look good.
//
// The report states which providers produced the numbers. A deterministic run
// proves the orchestration; it does not prove a model diagnoses well or that
// real audio was judged. Those are different claims and the header says so.

import { buildWorld, makeTurn, AYESHA, AISHA, SESSION, TENANT } from "../scenario.ts";
import type { World } from "../scenario.ts";
import type { RepairOutcome } from "../orchestrator.ts";
import { loadEnv } from "../util/env.ts";

interface ScenarioResult {
  id: string;
  description: string;
  expectation: string;
  passed: boolean;
  observed: string;
  latencyMs: number | null;
  usage: RepairOutcome["usage"] | null;
}

type Scenario = {
  id: string;
  description: string;
  expectation: string;
  run: () => Promise<{ passed: boolean; observed: string; latencyMs?: number | null; usage?: RepairOutcome["usage"] | null }>;
};

function freshWorld(): World {
  return buildWorld({ offline: true });
}

function failingTurn(turnId = "t-1") {
  return makeTurn({
    turnId,
    intendedText: "Good morning Ayesha, your order is ready.",
    entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
    applied: {},
    transcript: "good morning this is Ayesha",
    injectedFault: "seeded-pronunciation-drop",
  });
}

const SCENARIOS: Scenario[] = [
  {
    id: "S1-detect-pronunciation",
    description: "Seeded pronunciation drop, correct display text.",
    expectation: "Opens exactly one pronunciation incident for the target entity.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(failingTurn());
      const pron = r.incidents.filter((i) => i.layer === "pronunciation");
      return {
        passed: pron.length === 1 && pron[0]!.entity_id === AYESHA.entity_id,
        observed: pron.length + " pronunciation incident(s): " + pron.map((i) => i.entity_id).join(","),
      };
    },
  },
  {
    id: "S2-localize-layer",
    description: "Specialist attribution on the seeded fault.",
    expectation: "Speech localizes to 'pronunciation'; perception does NOT claim recognition.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(failingTurn());
      const out = await w.orchestrator.runRepairLoop(r.incidents.find((i) => i.layer === "pronunciation")!);
      const speech = out.findings.find((f) => f.specialist === "speech")!;
      const perception = out.findings.find((f) => f.specialist === "perception")!;
      return {
        passed: speech.layer === "pronunciation" && perception.layer !== "recognition",
        observed: "speech=" + speech.layer + " perception=" + perception.layer,
        latencyMs: out.detectionToActivationMs,
        usage: out.usage,
      };
    },
  },
  {
    id: "S3-two-candidates",
    description: "Bounded candidate generation (plan §9 caps at two).",
    expectation: "At most two candidates are commissioned and each is measured.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(failingTurn());
      const out = await w.orchestrator.runRepairLoop(r.incidents.find((i) => i.layer === "pronunciation")!);
      return {
        passed: out.candidates.length > 0 && out.candidates.length <= 2 && out.verdicts.length === out.candidates.length,
        observed: out.candidates.length + " candidate(s), " + out.verdicts.length + " verdict(s)",
        usage: out.usage,
      };
    },
  },
  {
    id: "S4-reject-harmful",
    description: "Candidate that pronounces the target as a different registered person.",
    expectation: "Refuted automatically; never released.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(failingTurn());
      const out = await w.orchestrator.runRepairLoop(r.incidents.find((i) => i.layer === "pronunciation")!);
      const harmful = out.candidates.find(
        (c) => (c.payload as { phonemes?: string }).phonemes === AISHA.reference_phonemes,
      );
      const verdict = harmful ? out.verdicts.find((v) => v.candidate_id === harmful.candidate_id) : undefined;
      return {
        passed: Boolean(verdict?.refuted) && out.decision.chosen_candidate_id !== harmful?.candidate_id,
        observed: harmful
          ? "refuted=" + verdict?.refuted + " by " + (verdict?.counterexamples.length ?? 0) + " counterexample(s)"
          : "harmful candidate was not proposed",
      };
    },
  },
  {
    id: "S5-gate-release",
    description: "Machine release gate on the surviving candidate.",
    expectation: "All six conditions pass and an artifact is issued.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(failingTurn());
      const out = await w.orchestrator.runRepairLoop(r.incidents.find((i) => i.layer === "pronunciation")!);
      return {
        passed: out.gate?.released === true && out.gate.conditions.every((c) => c.passed) && out.artifact !== null,
        observed: out.gate
          ? out.gate.conditions.filter((c) => c.passed).length + "/6 conditions passed"
          : "gate not reached: " + out.decision.action,
        latencyMs: out.detectionToActivationMs,
        usage: out.usage,
      };
    },
  },
  {
    id: "S6-fresh-utterance",
    description: "A genuinely new sentence rendered under the released repair.",
    expectation: "Verifies against the reference and resolves the incident.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(failingTurn());
      const inc = r.incidents.find((i) => i.layer === "pronunciation")!;
      const out = await w.orchestrator.runRepairLoop(inc);
      const phonemes = (out.artifact!.repair.payload as { phonemes: string }).phonemes;
      const second = await w.orchestrator.ingest(
        makeTurn({
          turnId: "t-2",
          intendedText: "Ayesha, I have updated your delivery address.",
          entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
          applied: { [AYESHA.entity_id]: phonemes },
          overlayVersion: 1,
        }),
      );
      const verified = second.observations[0]?.verified === true;
      return {
        passed: verified && w.store.getIncident(inc.incident_id)!.status === "resolved",
        observed: "verified=" + verified + " status=" + w.store.getIncident(inc.incident_id)!.status,
      };
    },
  },
  {
    id: "S7-negative-asia",
    description: "NEGATIVE CONTROL: 'Asia' used correctly as a continent.",
    expectation: "No incident opened, nothing rewritten.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(
        makeTurn({
          turnId: "t-asia",
          intendedText: "Our Asia team will follow up tomorrow.",
          entities: [],
          applied: {},
          transcript: "how is the Asia team doing",
        }),
      );
      return { passed: r.incidents.length === 0, observed: r.incidents.length + " incident(s)" };
    },
  },
  {
    id: "S8-no-reference",
    description: "Entity registered with NO reference recording.",
    expectation: "System abstains; no pronunciation repair attempted.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(
        makeTurn({
          turnId: "t-kh",
          intendedText: "Please confirm with Khadija before we proceed.",
          entities: [{ entity_id: "demo-person-31", surface: "Khadija" }],
          applied: {},
        }),
      );
      return {
        passed: r.incidents.filter((i) => i.layer === "pronunciation").length === 0,
        observed: r.incidents.length + " incident(s)",
      };
    },
  },
  {
    id: "S9-rollback",
    description: "Repaired utterance regresses after release.",
    expectation: "Rolled back to a HIGHER overlay version; entity quarantined.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(failingTurn());
      const inc = r.incidents.find((i) => i.layer === "pronunciation")!;
      await w.orchestrator.runRepairLoop(inc);
      const before = w.overlays.overlayVersion(SESSION);
      const res = await w.orchestrator.ingest(
        makeTurn({
          turnId: "t-bad",
          intendedText: "Ayesha, your appointment is confirmed.",
          entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
          applied: { [AYESHA.entity_id]: "/totally-wrong/" },
          overlayVersion: 1,
        }),
      );
      const after = w.overlays.overlayVersion(SESSION);
      return {
        passed:
          res.observations[0]?.rolledBack === true &&
          after > before &&
          w.overlays.serve(SESSION).repairs.length === 0 &&
          w.registry.get(TENANT, AYESHA.entity_id)!.status === "quarantined",
        observed: "overlay " + before + " -> " + after + ", repairs=" + w.overlays.serve(SESSION).repairs.length,
      };
    },
  },
  {
    id: "S10-duplicate-incident",
    description: "The same evidence posted twice.",
    expectation: "One incident, one set of app writes.",
    run: async () => {
      const w = freshWorld();
      await w.orchestrator.ingest(failingTurn());
      const again = await w.orchestrator.ingest(failingTurn());
      return {
        passed: again.duplicate && w.store.listIncidents().filter((i) => i.layer === "pronunciation").length === 1,
        observed: "duplicate=" + again.duplicate + " incidents=" + w.store.listIncidents().length,
      };
    },
  },
  {
    id: "S11-superseded-turn",
    description: "Audio delivered after the turn was superseded.",
    expectation: "Opens a runtime incident, not a pronunciation one.",
    run: async () => {
      const w = freshWorld();
      const turn = makeTurn({ turnId: "t-race", intendedText: "One moment please.", entities: [] });
      turn.delivery_events = [
        { type: "superseded", client_ts: 100 },
        { type: "playback_start", client_ts: 400 },
      ];
      const r = await w.orchestrator.ingest(turn);
      return {
        passed: r.incidents.some((i) => i.layer === "runtime") && !r.incidents.some((i) => i.layer === "pronunciation"),
        observed: r.incidents.map((i) => i.layer).join(",") || "none",
      };
    },
  },
  {
    id: "S12-version-revalidation",
    description: "Base version changed between diagnosis and release.",
    expectation: "Gate condition 5 blocks the release as stale.",
    run: async () => {
      const w = freshWorld();
      const r = await w.orchestrator.ingest(
        makeTurn({
          turnId: "t-ver",
          intendedText: "Good morning Ayesha.",
          entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
          applied: {},
        }),
      );
      const inc = r.incidents.find((i) => i.layer === "pronunciation")!;
      // Simulate the runtime moving to a new base between detection and release.
      w.store.updateIncident(inc.incident_id, { observed_version: "base-0+overlay.0" });
      const out = await w.orchestrator.runRepairLoop(w.store.getIncident(inc.incident_id)!);
      return {
        passed: out.gate?.released === false && (out.gate?.blockedBy ?? "").includes("condition 5"),
        observed: out.gate ? (out.gate.blockedBy ?? "released") : "gate not reached",
      };
    },
  },
];

/* ------------------------------------------------------------------ */

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => "| " + r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  return [line(rows[0]!), sep, ...rows.slice(1).map(line)].join("\n");
}

export async function runEval(): Promise<{ results: ScenarioResult[]; passed: number }> {
  const results: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    try {
      const r = await scenario.run();
      results.push({
        id: scenario.id,
        description: scenario.description,
        expectation: scenario.expectation,
        passed: r.passed,
        observed: r.observed,
        latencyMs: r.latencyMs ?? null,
        usage: r.usage ?? null,
      });
    } catch (err) {
      results.push({
        id: scenario.id,
        description: scenario.description,
        expectation: scenario.expectation,
        passed: false,
        observed: "threw: " + String(err instanceof Error ? err.message : err),
        latencyMs: null,
        usage: null,
      });
    }
  }

  return { results, passed: results.filter((r) => r.passed).length };
}

export function renderReport(results: ScenarioResult[], world: World): string {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  const latencies = results.map((r) => r.latencyMs).filter((n): n is number => n !== null);
  const usages = results.map((r) => r.usage).filter((u): u is RepairOutcome["usage"] => u !== null);

  const lines: string[] = [];
  lines.push("# Ruhana Evolve — evaluation report");
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push("| Component | Implementation | Live? |");
  lines.push("|---|---|---|");
  lines.push("| Specialist / supervisor LLM | " + world.llm.name + " | " + (world.live.llm ? "yes" : "**no — deterministic stand-in**") + " |");
  lines.push("| Acoustic judge | " + world.judge.name + " | " + (world.live.judge ? "yes" : "**no — phoneme-string comparison, not audio analysis**") + " |");
  lines.push("| Renderer | " + world.renderer.name + " | " + (world.live.renderer ? "yes" : "**no — simulated G2P**") + " |");
  lines.push("");

  if (!world.live.judge || !world.live.renderer) {
    lines.push("> **What this run does and does not establish.** These scenarios exercise the real");
    lines.push("> orchestration: detection, evidence-scoped specialists, bounded candidates, the");
    lines.push("> adversarial verifier, the six gate conditions, overlay versioning and rollback.");
    lines.push("> They do **not** establish that real audio was judged or that a language model");
    lines.push("> diagnoses well, because the judge and renderer above are deterministic stand-ins.");
    lines.push("> Those claims require a live Kokoro renderer and an audio-capable judge.");
    lines.push("");
  }

  lines.push("## Scenario results");
  lines.push("");
  lines.push(
    table([
      ["Scenario", "Pre-decided expectation", "Result", "Observed"],
      ...results.map((r) => [r.id, r.expectation, r.passed ? "PASS" : "FAIL", r.observed]),
    ]),
  );
  lines.push("");
  lines.push("**" + passed + "/" + total + " scenarios met their pre-decided expectation.**");
  lines.push("");

  lines.push("## Measures (plan §14)");
  lines.push("");
  const measures: string[][] = [
    ["Measure", "Value", "What it establishes"],
    [
      "Detection on labelled incidents",
      countOf(results, ["S1-detect-pronunciation", "S11-superseded-turn"]),
      "Whether the system notices the tested failures.",
    ],
    ["Correct layer localization", countOf(results, ["S2-localize-layer"]), "Whether it changes the responsible component."],
    ["Successful fresh utterances", countOf(results, ["S6-fresh-utterance"]), "Whether a released change improves new output."],
    ["Negative controls held", countOf(results, ["S7-negative-asia", "S8-no-reference"]), "Whether repair harms nearby cases."],
    ["Harmful candidates rejected", countOf(results, ["S4-reject-harmful"]), "Whether automatic restraint works."],
    ["Rollback contained", countOf(results, ["S9-rollback"]), "Whether regressions are contained."],
    ["Stale-version release blocked", countOf(results, ["S12-version-revalidation"]), "Whether revalidation is enforced."],
    [
      "Detection-to-activation latency",
      latencies.length > 0 ? Math.min(...latencies) + "–" + Math.max(...latencies) + " ms" : "n/a",
      "Whether 'next turn' is operationally plausible. Deterministic-clock value; not a wall-clock benchmark.",
    ],
    [
      "Usage per repair",
      usages.length > 0
        ? Math.round(avg(usages.map((u) => u.llmCalls))) +
          " LLM calls, " +
          Math.round(avg(usages.map((u) => u.renders))) +
          " renders, " +
          Math.round(avg(usages.map((u) => u.judgements))) +
          " judgements"
        : "n/a",
      "Whether free-tier demonstration and later costs are plausible.",
    ],
  ];
  lines.push(table(measures));
  lines.push("");

  lines.push("## Statistical limitation");
  lines.push("");
  lines.push(
    "This is a " +
      total +
      "-scenario suite of designed fault tests. It demonstrates tested control behaviour, not measured real-world success rates. Plan §14: even 20 independent trials with zero failures leave a one-sided 95% binomial upper failure bound of about 14%, and these fixtures are correlated, so they support less generalization than that.",
  );
  lines.push("");

  return lines.join("\n");
}

function countOf(results: ScenarioResult[], ids: string[]): string {
  const relevant = results.filter((r) => ids.includes(r.id));
  return relevant.filter((r) => r.passed).length + " / " + relevant.length;
}

function avg(ns: number[]): number {
  return ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length;
}

/* Run directly */
if (import.meta.url.endsWith("run.ts") && process.argv[1]?.endsWith("run.ts")) {
  const world = buildWorld({ offline: true, env: loadEnv() });
  const { results, passed } = await runEval();
  console.log(renderReport(results, world));
  process.exit(passed === results.length ? 0 : 1);
}
