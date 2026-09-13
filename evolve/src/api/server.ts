// The Evolve HTTP service.
//
// Two endpoints are the frozen contract with Part A and must stay wire-identical
// to contracts/mocks/evolve-mock.ts — that mock is what the runtime develops
// against, so any divergence here surfaces only at wire-up:
//
//   POST /api/evidence/turn        -> { accepted, duplicate }
//   GET  /api/session/{id}/repairs -> RepairOverlay
//
// The rest is Evolve's own dashboard surface (the "back half" of the demo UI in
// WORK-SPLIT), which Part A never calls.
//
// Note the POST returns as soon as detection has run. The repair loop is started
// but NOT awaited: plan §5 requires the conversation never to wait on a
// multi-agent round trip.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceTurn } from "../../../contracts/types.ts";
import { buildWorld, makeTurn, AYESHA, SESSION, TENANT, type World } from "../scenario.ts";
import { describeCapabilities, loadEnv } from "../util/env.ts";
import type { Incident } from "../domain/model.ts";

const PORT = Number(process.env.PORT ?? 4830);

/** Minimal shape check before anything touches the store. */
function validateTurn(body: unknown): { ok: true; turn: EvidenceTurn } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const t = body as Partial<EvidenceTurn>;
  for (const field of ["tenant", "session_id", "turn_id", "utterance_id", "effective_version"] as const) {
    if (typeof t[field] !== "string" || !t[field]) {
      return { ok: false, error: "missing or invalid field: " + field };
    }
  }
  if (!Array.isArray(t.entities)) return { ok: false, error: "entities must be an array" };
  if (!Array.isArray(t.delivery_events)) return { ok: false, error: "delivery_events must be an array" };
  return { ok: true, turn: body as EvidenceTurn };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      // A runaway body must not be able to exhaust the service.
      if (data.length > 2_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function createEvolveServer(world: World) {
  /** Incidents whose repair loop is already running, so a retry cannot double-run it. */
  const running = new Set<string>();
  /** Last completed outcome per incident, for the dashboard. */
  const outcomes = new Map<string, import("../orchestrator.ts").RepairOutcome>();

  async function repairInBackground(incidents: Incident[]): Promise<void> {
    for (const incident of incidents) {
      if (running.has(incident.incident_id)) continue;
      running.add(incident.incident_id);
      try {
        const outcome = await world.orchestrator.runRepairLoop(incident);
        outcomes.set(incident.incident_id, outcome);
        console.log(
          "[evolve] " +
            incident.incident_id +
            " " +
            incident.layer +
            " -> " +
            outcome.decision.action +
            (outcome.artifact ? " " + outcome.artifact.repair_id : "") +
            (outcome.detectionToActivationMs !== null
              ? " (" + outcome.detectionToActivationMs + "ms)"
              : ""),
        );
      } catch (err) {
        console.error("[evolve] repair loop failed for " + incident.incident_id + ":", err);
      } finally {
        running.delete(incident.incident_id);
      }
    }
  }

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost:" + PORT);
      const repairsMatch = /^\/api\/session\/([^/]+)\/repairs$/.exec(url.pathname);

      try {
        /* ---- Contract 1 ------------------------------------------- */
        if (req.method === "POST" && url.pathname === "/api/evidence/turn") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readBody(req));
          } catch {
            return json(res, 400, { accepted: false, error: "invalid JSON" });
          }

          const check = validateTurn(parsed);
          if (!check.ok) return json(res, 400, { accepted: false, error: check.error });

          const result = await world.orchestrator.ingest(check.turn);

          // Answer Part A immediately, then repair in the background.
          json(res, 200, { accepted: result.accepted, duplicate: result.duplicate });
          if (result.incidents.length > 0) void repairInBackground(result.incidents);
          return;
        }

        /* ---- Contract 2 ------------------------------------------- */
        if (req.method === "GET" && repairsMatch) {
          return json(res, 200, world.overlays.serve(decodeURIComponent(repairsMatch[1]!)));
        }


        /* ---- Dashboard page ---------------------------------------- */
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          // Read per request rather than caching: during a demo you want an
          // edit to show up on refresh, not after a restart.
          const html = readFileSync(join(process.cwd(), "evolve", "web", "index.html"), "utf8");
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(html);
          return;
        }

        /* ---- Browser-driven demo (plan §12) ------------------------ */
        // These post the SAME evidence Part A's runtime would post. They are a
        // convenience for driving the loop from a browser, not a separate code
        // path: everything downstream is the real ingest.
        if (req.method === "POST" && url.pathname.startsWith("/api/demo/")) {
          const step = url.pathname.slice("/api/demo/".length);
          const overlay = world.overlays.overlayVersion(SESSION);
          const active = world.overlays.serve(SESSION).repairs[0];
          const phonemes = (active?.payload as { phonemes?: string } | undefined)?.phonemes;

          let turn;
          if (step === "seed") {
            turn = makeTurn({
              turnId: "t-1",
              intendedText: "Good morning Ayesha, your order is ready.",
              entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
              applied: {},
              transcript: "good morning this is Ayesha",
              injectedFault: "seeded-pronunciation-drop",
            });
          } else if (step === "fresh") {
            if (!phonemes) {
              return json(res, 409, { error: "no repair is active yet — seed the failing turn first" });
            }
            turn = makeTurn({
              turnId: "t-2",
              intendedText: "Ayesha, I have updated your delivery address.",
              entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
              applied: { [AYESHA.entity_id]: phonemes },
              overlayVersion: overlay,
            });
          } else if (step === "regress") {
            if (!phonemes) {
              return json(res, 409, { error: "no repair is active to regress — seed first" });
            }
            turn = makeTurn({
              turnId: "t-3",
              intendedText: "Ayesha, your appointment is confirmed.",
              entities: [{ entity_id: AYESHA.entity_id, surface: AYESHA.canonical_text }],
              applied: { [AYESHA.entity_id]: "/regressed-voice-model/" },
              overlayVersion: overlay,
            });
          } else {
            return json(res, 404, { error: "unknown demo step: " + step });
          }

          const result = await world.orchestrator.ingest(turn);
          if (result.incidents.length > 0) void repairInBackground(result.incidents);

          return json(res, 200, {
            message:
              step === "seed"
                ? result.duplicate
                  ? "already seeded — reset the service to run it again"
                  : "incident opened; agents are diagnosing"
                : step === "fresh"
                  ? result.observations[0]?.verified
                    ? "fresh utterance verified against the reference"
                    : "fresh utterance did NOT verify: " + (result.observations[0]?.detail ?? "no observation")
                  : result.observations[0]?.rolledBack
                    ? "regression detected — repair rolled back, entity quarantined"
                    : "no rollback: " + (result.observations[0]?.detail ?? "no observation"),
            incidents: result.incidents.map((i) => i.incident_id),
            observations: result.observations,
            tenant: TENANT,
          });
        }
        /* ---- Evolve's own dashboard surface ----------------------- */
        if (req.method === "GET" && url.pathname === "/api/dashboard") {
          const incidents = world.store.listIncidents();
          return json(res, 200, {
            incidents: incidents.map((i) => {
              const outcome = outcomes.get(i.incident_id);
              return {
                ...i,
                artifact: i.released_repair_id
                  ? world.store.getArtifact(i.released_repair_id)
                  : null,
                // The reasoning, not just the verdict. Plan §12's dashboard
                // priorities: diagnosed layer, candidate results, active
                // version, and the concise specialist exchange.
                findings: outcome?.findings ?? [],
                discussion: outcome?.discussion ?? [],
                candidates: outcome?.candidates ?? [],
                verdicts: outcome?.verdicts ?? [],
                gate: outcome?.gate ?? null,
                decision: outcome?.decision ?? null,
                supervisor_overrode: outcome?.supervisorOverrode ?? null,
                detection_to_activation_ms: outcome?.detectionToActivationMs ?? null,
                usage: outcome?.usage ?? null,
                running: running.has(i.incident_id),
              };
            }),
            artifacts: world.store.listArtifacts(),
            active_sessions: world.overlays.activeSessions().map((s) => world.overlays.serve(s)),
            app_writes: world.queue.results(),
            providers: {
              llm: world.llm.name,
              judge: world.judge.name,
              renderer: world.renderer.name,
              live: world.live,
            },
          });
        }

        if (req.method === "GET" && url.pathname === "/api/incidents") {
          return json(res, 200, world.store.listIncidents());
        }

        if (req.method === "GET" && url.pathname === "/health") {
          return json(res, 200, { ok: true, evidence: world.store.knownEvidenceIds().length });
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      } catch (err) {
        console.error("[evolve] unhandled:", err);
        if (!res.headersSent) json(res, 500, { error: "internal error" });
      }
    })();
  });
}

/* Started directly: node --experimental-strip-types evolve/src/api/server.ts */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  const env = loadEnv();
  const world = buildWorld({ env });
  createEvolveServer(world).listen(PORT, () => {
    console.log("evolve service on http://localhost:" + PORT);
    console.log("  capabilities: " + describeCapabilities(env));
    console.log("  llm=" + world.llm.name + " judge=" + world.judge.name + " renderer=" + world.renderer.name);
  });
}
