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
import type { EvidenceTurn } from "../../../contracts/types.ts";
import { buildWorld, type World } from "../scenario.ts";
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

  async function repairInBackground(incidents: Incident[]): Promise<void> {
    for (const incident of incidents) {
      if (running.has(incident.incident_id)) continue;
      running.add(incident.incident_id);
      try {
        const outcome = await world.orchestrator.runRepairLoop(incident);
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

        /* ---- Evolve's own dashboard surface ----------------------- */
        if (req.method === "GET" && url.pathname === "/api/dashboard") {
          const incidents = world.store.listIncidents();
          return json(res, 200, {
            incidents: incidents.map((i) => ({
              ...i,
              artifact: i.released_repair_id
                ? world.store.getArtifact(i.released_repair_id)
                : null,
            })),
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
