// Demo web server (Part A live wiring): Anam avatar + our TTS + real Evolve.
//
//   npm run web            (expects kokoro worker on :8880 and evolve on :4830)
//
// The browser page drives an Anam passthrough session; every "customer turn"
// runs through the SAME TurnController the tests exercise: overlay snapshot ->
// speech input -> Kokoro -> evidence to Evolve; repairs are polled and applied
// at turn boundaries.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionOverlayStore } from "../src/overlay.ts";
import { TurnController } from "../src/turn-controller.ts";
import { RepairsClient } from "../src/repairs-client.ts";
import { HttpEvidenceSink } from "../src/evidence.ts";
import { KokoroHttpEngine } from "../src/tts/engine.ts";
import { resamplePcm16 } from "../src/audio/pcm.ts";
import { buildPassthroughSessionConfig } from "../src/anam/session-config.ts";
import type { EntityRef } from "../../contracts/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT ?? 4900);
const EVOLVE_URL = process.env.EVOLVE_URL ?? "http://127.0.0.1:4830";
const KOKORO_URL = process.env.KOKORO_URL ?? "http://127.0.0.1:8880";
const TENANT = "demo";
const SESSION = "s-42";

// Known demo entities (matches evolve/src/scenario.ts registry).
const ENTITIES: { surface: string; entity_id: string }[] = [
  { surface: "Ayesha", entity_id: "demo-person-17" },
  { surface: "Aisha", entity_id: "demo-person-22" },
  { surface: "Khadija", entity_id: "demo-person-31" },
];

function entitiesIn(text: string): EntityRef[] {
  return ENTITIES.filter((e) => new RegExp(`\\b${e.surface}\\b`).test(text)).map((e) => ({
    entity_id: e.entity_id,
    surface: e.surface,
    canonical_text: e.surface,
  }));
}

const overlay = new SessionOverlayStore("base-1", TENANT, SESSION);
const repairs = new RepairsClient(EVOLVE_URL, SESSION, overlay);
const controller = new TurnController(
  TENANT,
  SESSION,
  overlay,
  new KokoroHttpEngine(KOKORO_URL, "af_heart"),
  new HttpEvidenceSink(EVOLVE_URL),
);
repairs.start(1000);

async function json(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const send = (code: number, payload: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(readFileSync(join(here, "index.html"), "utf8"));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session-token") {
      const config = buildPassthroughSessionConfig({
        avatarId: process.env.ANAM_AVATAR_ID ?? "",
        name: "Ruhana Evolve demo",
      });
      const anamRes = await fetch("https://api.anam.ai/v1/auth/session-token", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.ANAM_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(config),
      });
      const body = await anamRes.json();
      send(anamRes.ok ? 200 : anamRes.status, body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/inject") {
      const { on } = await json(req);
      if (on) controller.injector.arm("demo-person-17");
      else controller.injector.disarm();
      send(200, { injected: controller.injector.activeFault()?.label ?? null });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/speak") {
      const { text } = (await json(req)) as { text?: string };
      if (!text) return send(400, { error: "text required" });
      const result = await controller.runTurn(async () => ({
        intendedText: text,
        entities: entitiesIn(text),
      }));
      if (result.status !== "delivered" || !result.utterance) {
        return send(409, { status: result.status });
      }
      const pcm16k = resamplePcm16(result.utterance.pcm, result.utterance.sampleRate, 16000);
      send(200, {
        status: "delivered",
        effective_version: result.utterance.effectiveVersion,
        display_text: text,
        speech_input: result.utterance.spokenSegments,
        injected_fault: result.evidence.injected_fault,
        sample_rate: 16000,
        pcm_base64: Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength).toString(
          "base64",
        ),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const snap = overlay.snapshot();
      send(200, {
        effective_version: snap.effectiveVersion,
        repairs: snap.repairs,
        injected_fault: controller.injector.activeFault()?.label ?? null,
      });
      return;
    }

    send(404, { error: "not found" });
  } catch (err) {
    send(500, { error: String(err) });
  }
}).listen(PORT, () => {
  console.log(`web demo on http://localhost:${PORT} (evolve=${EVOLVE_URL} kokoro=${KOKORO_URL})`);
});
