// The demo world (plan §12).
//
// One place that wires every dependency, so the demo runner, the eval suite and
// the tests all exercise the SAME system rather than three lookalikes.
//
// Entities are synthetic, per plan §15 ("Use synthetic entities for the first
// demonstration"). The reference pronunciations below stand in for what a human
// reference recording would yield; replacing them with phonemes derived from a
// real recording is a data change, not a code change.

import { join } from "node:path";
import type { EvidenceTurn } from "../../contracts/types.ts";
import { InMemoryRegistry } from "./domain/registry.ts";
import { SessionOverlayRegistry } from "./domain/overlay-store.ts";
import { InMemoryStore } from "./providers/store.ts";
import { FakeRenderer, HttpKokoroRenderer, type CandidateRenderer } from "./providers/renderer.ts";
import {
  OpenAIAudioJudge,
  PhonemeMatchJudge,
  type AudioJudge,
} from "./providers/audio-judge.ts";
import { OpenAILLM, ScriptedLLM, type LLM } from "./providers/llm.ts";
import { OpenAITranscriber } from "./providers/decoder.ts";
import { FakeClock, systemClock, type Clock } from "./providers/clock.ts";
import {
  MemorySpecialist,
  PerceptionSpecialist,
  SpeechSpecialist,
  type IndependentDecoder,
} from "./agents/specialists.ts";
import { Supervisor } from "./agents/supervisor.ts";
import { AdversarialVerifier, loadFixtures } from "./agents/verifier.ts";
import { AppWriteQueue } from "./apps/queue.ts";
import { GithubConnector, SentryConnector, SlackConnector } from "./apps/connectors.ts";
import { EvolveOrchestrator, type AppConnectors } from "./orchestrator.ts";
import { loadEnv, type Env } from "./util/env.ts";

export const TENANT = "demo";
export const SESSION = "s-42";
export const BASE_VERSION = "base-1";
export const VOICE = "kokoro-82m/af_heart";

/** The target entity. Reference pronunciation stands in for a human recording. */
export const AYESHA = {
  entity_id: "demo-person-17",
  canonical_text: "Ayesha",
  reference_phonemes: "/ɑːˈjeɪʃə/",
};

/** A near neighbour. A repair for Ayesha must never make these two collide. */
export const AISHA = {
  entity_id: "demo-person-22",
  canonical_text: "Aisha",
  reference_phonemes: "/ˈaɪʃə/",
};

/** Registered but with NO reference recording: the system must abstain. */
export const KHADIJA = {
  entity_id: "demo-person-31",
  canonical_text: "Khadija",
};

/** What the TTS engine produces for a bare name — i.e. the failure. */
export const DEFAULT_G2P: Record<string, string> = {
  Ayesha: "/əˈiːʃə/",
  Aisha: "/ˈaɪʃə/",
  Khadija: "/kəˈdiːdʒə/",
  Asia: "/ˈeɪʒə/",
};

export function buildRegistry(): InMemoryRegistry {
  const registry = new InMemoryRegistry();

  registry.seed({
    entity_id: AYESHA.entity_id,
    tenant: TENANT,
    canonical_text: AYESHA.canonical_text,
    language: "en",
    reference_audio_id: "private-reference-7",
    reference_phonemes: AYESHA.reference_phonemes,
    recognition_hints: ["Ayesha"],
    // Plan §6A: "Asia" must remain "Asia" when the conversation concerns the continent.
    must_not_rewrite: ["Asia", "Asian"],
    voice_model_version: VOICE,
    status: "active",
  });

  registry.seed({
    entity_id: AISHA.entity_id,
    tenant: TENANT,
    canonical_text: AISHA.canonical_text,
    language: "en",
    reference_audio_id: "private-reference-22",
    reference_phonemes: AISHA.reference_phonemes,
    recognition_hints: ["Aisha"],
    must_not_rewrite: [],
    voice_model_version: VOICE,
    status: "active",
  });

  registry.seed({
    entity_id: KHADIJA.entity_id,
    tenant: TENANT,
    canonical_text: KHADIJA.canonical_text,
    language: "en",
    reference_audio_id: null,
    reference_phonemes: null, // no ground truth -> the system must abstain
    recognition_hints: [],
    must_not_rewrite: [],
    voice_model_version: VOICE,
    status: "active",
  });

  return registry;
}

/* ------------------------------------------------------------------ *
 * Scripted model behaviour
 * ------------------------------------------------------------------ */

/**
 * The scripted speech specialist proposes two candidates, exactly as plan §9
 * caps it:
 *
 *   A — derived from the reference recording. Correct.
 *   B — the pronunciation of a DIFFERENT registered person. This is a realistic
 *       model error ("Ayesha" and "Aisha" are routinely conflated) and it is the
 *       candidate the verifier must reject: it would make two real people
 *       indistinguishable in speech.
 *
 * Neither is marked as the winner anywhere. Which one survives is decided by
 * rendering both and measuring them (plan §7).
 */
export function scriptedLLM(): ScriptedLLM {
  return new ScriptedLLM({
    "speech.propose_candidates": () =>
      JSON.stringify({
        candidates: [
          {
            phonemes: AYESHA.reference_phonemes,
            rationale:
              "Derived from the stored reference recording for this entity, holding text, voice and model fixed.",
          },
          {
            phonemes: AISHA.reference_phonemes,
            rationale:
              "Alternative reading treating the name as the more common short form.",
          },
        ],
      }),
    "supervisor.decide": (req) => {
      // The scripted supervisor picks the first candidate that survived
      // verification, which the orchestrator has already filtered for it.
      const parsed = JSON.parse(req.user) as {
        candidates_that_survived_verification?: { candidate_id: string }[];
      };
      const first = parsed.candidates_that_survived_verification?.[0];
      return JSON.stringify({
        action: first ? "release" : "reject",
        chosen_candidate_id: first?.candidate_id ?? null,
        rationale: first
          ? "This candidate matched the reference and survived every protected fixture, including the neighbouring-entity control."
          : "No candidate survived verification.",
      });
    },
  });
}

/* ------------------------------------------------------------------ *
 * Evidence builders — what Part A would post
 * ------------------------------------------------------------------ */

export interface TurnOptions {
  turnId: string;
  utteranceId?: string;
  intendedText: string;
  entities: { entity_id: string; surface: string }[];
  /** Phoneme overrides actually applied, keyed by entity id. */
  applied?: Record<string, string>;
  overlayVersion?: number;
  transcript?: string;
  injectedFault?: string | null;
  micAudioUrl?: string;
  serverTs?: string;
}

/** Builds an EvidenceTurn the way Part A's TurnEvidenceBuilder would. */
export function makeTurn(opts: TurnOptions): EvidenceTurn {
  const applied = opts.applied ?? {};
  const segments: EvidenceTurn["speech_input"] = [];

  let cursor = 0;
  const text = opts.intendedText;
  const placements = opts.entities
    .map((e) => ({ e, idx: text.indexOf(e.surface) }))
    .filter((p) => p.idx !== -1 && applied[p.e.entity_id] !== undefined)
    .sort((a, b) => a.idx - b.idx);

  for (const p of placements) {
    if (p.idx > cursor) segments.push({ kind: "text", text: text.slice(cursor, p.idx) });
    segments.push({
      kind: "phoneme",
      display: p.e.surface,
      phonemes: applied[p.e.entity_id]!,
      entity_id: p.e.entity_id,
    });
    cursor = p.idx + p.e.surface.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  if (segments.length === 0) segments.push({ kind: "text", text });

  return {
    tenant: TENANT,
    session_id: SESSION,
    turn_id: opts.turnId,
    utterance_id: opts.utteranceId ?? opts.turnId + "-u1",
    effective_version: BASE_VERSION + "+overlay." + (opts.overlayVersion ?? 0),
    mic_audio_url: opts.micAudioUrl ?? "memory://mic/" + opts.turnId,
    primary_transcript: opts.transcript
      ? { text: opts.transcript, model: "whisper-large-v3", confidence: 0.9 }
      : undefined,
    entities: opts.entities,
    intended_text: opts.intendedText,
    speech_input: segments,
    generated_audio_url: "memory://audio/" + opts.turnId,
    delivery_events: [
      { type: "passthrough_submitted", client_ts: 0 },
      { type: "playback_start", client_ts: 120 },
      { type: "playback_end", client_ts: 1800 },
    ],
    injected_fault: opts.injectedFault ?? null,
    server_ts: opts.serverTs ?? "2026-09-14T00:00:00.000Z",
  };
}

/* ------------------------------------------------------------------ *
 * World construction
 * ------------------------------------------------------------------ */

export interface WorldOptions {
  /** Force the deterministic providers even when keys are present. */
  offline?: boolean;
  env?: Env;
  clock?: Clock;
  /** Injected fetch for the app connectors, so tests can record requests. */
  appFetch?: typeof fetch;
  /** Enable connectors even without real credentials (tests supply appFetch). */
  forceApps?: boolean;
  /**
   * Independent decoder override. Offline there is genuinely no second
   * recognizer, so the default is null and perception abstains — which is the
   * honest report. The recognition tests supply a ScriptedDecoder explicitly.
   */
  decoder?: IndependentDecoder | null;
}

export interface World {
  orchestrator: EvolveOrchestrator;
  registry: InMemoryRegistry;
  store: InMemoryStore;
  overlays: SessionOverlayRegistry;
  queue: AppWriteQueue;
  renderer: CandidateRenderer;
  judge: AudioJudge;
  llm: LLM;
  /** Named separately so a run can show the §9 supervisor/worker model split. */
  supervisorName: string;
  clock: Clock;
  apps: AppConnectors;
  live: { llm: boolean; judge: boolean; renderer: boolean; apps: boolean };
}

export function fixturesPath(): string {
  return join(process.cwd(), "fixtures", "protected", "pronunciation.fixtures.json");
}

export function buildWorld(options: WorldOptions = {}): World {
  const env = options.env ?? loadEnv();
  const offline = options.offline ?? false;

  const openaiKey = env.OPENAI_API_KEY;
  const effort = (env.OPENAI_REASONING_EFFORT ?? "low") as "minimal" | "low" | "medium" | "high";

  // Plan §9: separate supervisor and worker model budgets. The heavier model
  // supervises; the faster one runs the specialists.
  const supervisorModel = env.EVOLVE_SUPERVISOR_MODEL ?? "gpt-5.6-luna";
  const specialistModel = env.EVOLVE_SPECIALIST_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.6-terra";

  const useOpenAI = Boolean(openaiKey) && !offline;
  const specialistLlm: LLM = useOpenAI
    ? new OpenAILLM(openaiKey!, specialistModel, effort)
    : scriptedLLM();
  const supervisorLlm: LLM = useOpenAI
    ? new OpenAILLM(openaiKey!, supervisorModel, effort)
    : specialistLlm;

  const renderer: CandidateRenderer =
    env.KOKORO_URL && !offline
      ? new HttpKokoroRenderer(env.KOKORO_URL)
      : new FakeRenderer(DEFAULT_G2P);

  const judge: AudioJudge =
    openaiKey && env.KOKORO_URL && !offline
      ? new OpenAIAudioJudge(openaiKey, env.EVOLVE_JUDGE_MODEL ?? "gpt-audio-1.5")
      : new PhonemeMatchJudge();

  const decoder =
    options.decoder !== undefined
      ? options.decoder
      : openaiKey && !offline
        ? new OpenAITranscriber(openaiKey, env.EVOLVE_STT_MODEL ?? "gpt-4o-transcribe")
        : null;

  const registry = buildRegistry();
  const store = new InMemoryStore();
  const overlays = new SessionOverlayRegistry(BASE_VERSION);
  const clock = options.clock ?? (offline ? new FakeClock() : systemClock);
  const queue = new AppWriteQueue();
  const fixtures = loadFixtures(fixturesPath());

  const appFetch = options.appFetch ?? fetch;
  const appsEnabled = options.forceApps ?? false;

  const apps: AppConnectors = {
    sentry:
      appsEnabled || (env.SENTRY_DSN && env.SENTRY_AUTH_TOKEN)
        ? new SentryConnector(
            {
              dsn: env.SENTRY_DSN ?? "https://publickey@o0.ingest.sentry.io/0",
              authToken: env.SENTRY_AUTH_TOKEN ?? "test-token",
              org: env.SENTRY_ORG ?? "demo-org",
              project: env.SENTRY_PROJECT ?? "ruhana-evolve",
            },
            appFetch,
          )
        : null,
    slack:
      appsEnabled || (env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID)
        ? new SlackConnector(
            {
              botToken: env.SLACK_BOT_TOKEN ?? "xoxb-test",
              channelId: env.SLACK_CHANNEL_ID ?? "C000TEST",
            },
            appFetch,
          )
        : null,
    github:
      appsEnabled || (env.GITHUB_TOKEN && env.GITHUB_REPO)
        ? new GithubConnector(
            {
              token: env.GITHUB_TOKEN ?? "ghp-test",
              repo: env.GITHUB_REPO ?? "demo-org/ruhana-evolve-demo",
              branch: env.GITHUB_BRANCH ?? "main",
            },
            appFetch,
          )
        : null,
  };

  const orchestrator = new EvolveOrchestrator({
    store,
    registry,
    overlays,
    perception: new PerceptionSpecialist(decoder),
    memory: new MemorySpecialist(),
    speech: new SpeechSpecialist(specialistLlm, judge),
    verifier: new AdversarialVerifier(registry, renderer, judge, fixtures),
    supervisor: new Supervisor(supervisorLlm),
    renderer,
    judge,
    fixtures,
    clock,
    queue,
    apps,
  });

  return {
    orchestrator,
    registry,
    store,
    overlays,
    queue,
    renderer,
    judge,
    llm: specialistLlm,
    supervisorName: supervisorLlm.name,
    clock,
    apps,
    live: {
      llm: useOpenAI,
      judge: judge.name.startsWith("openai"),
      renderer: renderer.name.startsWith("kokoro"),
      apps: Boolean(env.SLACK_BOT_TOKEN ?? env.SENTRY_DSN ?? env.GITHUB_TOKEN),
    },
  };
}
