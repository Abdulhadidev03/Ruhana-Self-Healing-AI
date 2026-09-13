// The Evolve loop: evidence in, verified repair out.
//
//   ingest()          detect a discrepancy and open an incident
//   runRepairLoop()   specialists -> candidates -> render -> verify -> supervise
//                     -> machine gate -> session overlay -> external records
//   observe()         check the NEXT utterance produced under the repair, and
//                     roll back if it regressed
//
// The order matters. Plan §5 splits this into "repair this conversation" and
// "preserve the improvement"; the session overlay is updated before any external
// app write is awaited, so a Slack or GitHub outage can never delay a correction
// that is already verified (plan §11).

import type { EvidenceTurn } from "../../contracts/types.ts";
import type { Repair } from "../../contracts/types.ts";
import { detect, type Discrepancy } from "./domain/detection.ts";
import { candidateId, payloadHash, repairId, incidentId as makeIncidentId } from "./domain/ids.ts";
import { issueArtifact } from "./domain/artifact.ts";
import { evaluateGate } from "./domain/gate.ts";
import type {
  AudioRef,
  Candidate,
  Finding,
  GateResult,
  Incident,
  ProposedExperiment,
  RepairArtifact,
  SupervisorDecision,
  Verdict,
} from "./domain/model.ts";
import type { MutableRegistry } from "./domain/registry.ts";
import { SessionOverlayRegistry } from "./domain/overlay-store.ts";
import { MemorySpecialist, PerceptionSpecialist, SpeechSpecialist } from "./agents/specialists.ts";
import { memoryView, perceptionView, speechView } from "./agents/protocol.ts";
import { Supervisor } from "./agents/supervisor.ts";
import { AdversarialVerifier, requiredFixtureIds, type FixtureSet } from "./agents/verifier.ts";
import type { EvolveStore } from "./providers/store.ts";
import type { CandidateRenderer } from "./providers/renderer.ts";
import type { AudioJudge } from "./providers/audio-judge.ts";
import type { Clock } from "./providers/clock.ts";
import { AppWriteQueue } from "./apps/queue.ts";
import type { GithubConnector, SentryConnector, SlackConnector } from "./apps/connectors.ts";

export interface AppConnectors {
  sentry: SentryConnector | null;
  slack: SlackConnector | null;
  github: GithubConnector | null;
}

export interface OrchestratorDeps {
  store: EvolveStore;
  registry: MutableRegistry;
  overlays: SessionOverlayRegistry;
  perception: PerceptionSpecialist;
  memory: MemorySpecialist;
  speech: SpeechSpecialist;
  verifier: AdversarialVerifier;
  supervisor: Supervisor;
  renderer: CandidateRenderer;
  judge: AudioJudge;
  fixtures: FixtureSet;
  clock: Clock;
  queue: AppWriteQueue;
  apps: AppConnectors;
  /** Repair types this tenant permits (gate condition 1). */
  allowedTypes?: Repair["type"][];
}

export interface RepairOutcome {
  incident: Incident;
  findings: Finding[];
  candidates: Candidate[];
  verdicts: Verdict[];
  decision: SupervisorDecision;
  supervisorOverrode: string | null;
  gate: GateResult | null;
  artifact: RepairArtifact | null;
  /** Plan §14: detection-to-activation latency. */
  detectionToActivationMs: number | null;
  /** Plan §14: model/audio usage per repair. */
  usage: { renders: number; judgements: number; llmCalls: number };
}

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  evidenceId: string;
  incidents: Incident[];
  /** Populated when ingestion also confirmed or refuted an active repair. */
  observations: ObservationResult[];
}

export interface ObservationResult {
  repairId: string;
  verified: boolean;
  detail: string;
  rolledBack: boolean;
}

export class EvolveOrchestrator {
  private readonly allowedTypes: Repair["type"][];

  constructor(private readonly deps: OrchestratorDeps) {
    this.allowedTypes = deps.allowedTypes ?? ["pronunciation", "entity_rebinding"];
  }

  /* ---------------------------------------------------------------- *
   * Contract 1 — evidence in
   * ---------------------------------------------------------------- */

  ingestOnly(turn: EvidenceTurn): { evidenceId: string; duplicate: boolean } {
    const { record, duplicate } = this.deps.store.putEvidence(turn, this.deps.clock.now());
    return { evidenceId: record.evidence_id, duplicate };
  }

  /**
   * Store the evidence, then detect. Returns immediately after detection;
   * running the repair loop is the caller's decision so the HTTP handler can
   * answer Part A without waiting for a multi-agent round trip.
   */
  async ingest(turn: EvidenceTurn): Promise<IngestResult> {
    const { evidenceId, duplicate } = this.ingestOnly(turn);

    if (duplicate) {
      return { accepted: true, duplicate: true, evidenceId, incidents: [], observations: [] };
    }

    // Before opening anything new: does this turn confirm or refute a repair
    // that is already active for this session?
    const observations = await this.observe(turn);

    const discrepancies = detect(turn, this.deps.registry);
    const incidents: Incident[] = [];

    for (const d of discrepancies) {
      incidents.push(this.openIncident(turn, evidenceId, d));
    }

    return { accepted: true, duplicate: false, evidenceId, incidents, observations };
  }

  private openIncident(turn: EvidenceTurn, evidenceId: string, d: Discrepancy): Incident {
    const id = makeIncidentId(turn.tenant, turn.session_id, d.layer, d.entity_id);
    const incident: Incident = {
      incident_id: id,
      tenant: turn.tenant,
      session_id: turn.session_id,
      turn_id: turn.turn_id,
      utterance_id: turn.utterance_id,
      layer: d.layer,
      entity_id: d.entity_id,
      observed_version: turn.effective_version,
      evidence_ids: [evidenceId],
      summary: d.summary,
      status: "open",
      opened_at: this.deps.clock.now(),
      released_repair_id: null,
      injected_fault: turn.injected_fault,
    };

    const { incident: stored, created } = this.deps.store.upsertIncident(incident);

    if (created && this.deps.apps.sentry) {
      const sentry = this.deps.apps.sentry;
      this.deps.queue.enqueue({
        key: "sentry:open:" + stored.incident_id,
        app: "sentry",
        stream: "sentry:" + stored.incident_id,
        description: "open issue for " + stored.incident_id,
        run: () => sentry.openIssue(stored, this.sensitiveTerms(stored.tenant)),
      });
    }
    if (created && this.deps.apps.slack) {
      const slack = this.deps.apps.slack;
      this.deps.queue.enqueue({
        key: "slack:open:" + stored.incident_id,
        app: "slack",
        stream: "slack:" + stored.incident_id,
        description: "open thread for " + stored.incident_id,
        run: () => slack.openThread(stored, this.sensitiveTerms(stored.tenant)),
      });
    }

    return stored;
  }

  /* ---------------------------------------------------------------- *
   * The repair loop
   * ---------------------------------------------------------------- */

  async runRepairLoop(incident: Incident): Promise<RepairOutcome> {
    const startedAt = this.deps.clock.now();
    const usage = { renders: 0, judgements: 0, llmCalls: 0 };

    this.deps.store.updateIncident(incident.incident_id, { status: "repairing" });

    const evidence = incident.evidence_ids
      .map((id) => this.deps.store.getEvidence(id))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const latest = evidence[evidence.length - 1];

    if (!latest) {
      return this.barrenOutcome(incident, "no retrievable evidence", startedAt, usage);
    }

    const turn = latest.turn;
    const candidatesInRegistry = this.deps.registry.list(incident.tenant);
    const targetEntity = incident.entity_id
      ? this.deps.registry.get(incident.tenant, incident.entity_id)
      : null;

    // --- Step 1: specialists inspect their OWN evidence, in parallel. ----
    // Parallel is not just for speed: it guarantees none of them can have seen
    // another's conclusion (plan §4 step 1).
    const generatedAudio = await this.audioForTurn(turn);
    const voiceModelVersion =
      targetEntity?.voice_model_version ?? this.deps.fixtures.voice_model_version;

    const [perception, memory, speech] = await Promise.all([
      this.deps.perception.run(perceptionView(latest.evidence_id, turn, candidatesInRegistry)),
      this.deps.memory.run(memoryView(latest.evidence_id, turn, candidatesInRegistry)),
      this.deps.speech.run(
        speechView(latest.evidence_id, turn, targetEntity, generatedAudio, voiceModelVersion),
      ),
    ]);

    const findings = [perception, memory, speech];
    usage.llmCalls += 1; // speech specialist's proposal call
    if (generatedAudio) usage.judgements += 1;

    this.postFindings(incident, findings);

    // --- Step 2: the supervisor commissions bounded experiments. --------
    const commissioned = this.deps.supervisor.commission(findings);
    const candidates = await this.buildCandidates(incident, commissioned, turn, voiceModelVersion, usage);

    // --- Step 3: the verifier attacks each candidate. -------------------
    const verdicts: Verdict[] = [];
    for (const candidate of candidates) {
      const verdict = await this.deps.verifier.verify(candidate, incident.tenant, incident.entity_id);
      usage.renders += this.deps.fixtures.fixtures.length;
      usage.judgements += this.deps.fixtures.fixtures.length;
      verdicts.push(verdict);
      this.postVerdict(incident, candidate, verdict);
    }

    // --- Step 4: structured decision. -----------------------------------
    const outcome = await this.deps.supervisor.decide({ incident, findings, candidates, verdicts });
    usage.llmCalls += 1;
    const decision = outcome.decision;

    if (decision.action !== "release" || decision.chosen_candidate_id === null) {
      const status = decision.action === "contain" ? "contained" : "rejected";
      const updated =
        this.deps.store.updateIncident(incident.incident_id, { status }) ?? incident;
      this.postDecision(updated, outcome.statement, {});
      return {
        incident: updated,
        findings,
        candidates,
        verdicts,
        decision,
        supervisorOverrode: outcome.overrode,
        gate: null,
        artifact: null,
        detectionToActivationMs: null,
        usage,
      };
    }

    const chosen = candidates.find((c) => c.candidate_id === decision.chosen_candidate_id)!;
    const verdict = verdicts.find((v) => v.candidate_id === chosen.candidate_id)!;

    // --- Step 5: the machine release gate. ------------------------------
    const overlayVersion = this.deps.overlays.nextOverlayVersion(incident.session_id);
    const baseVersion = this.deps.overlays.baseVersion(incident.session_id);

    const gate = evaluateGate(
      {
        incident,
        candidate: chosen,
        verdict,
        decision,
        activeBaseVersion: baseVersion,
        requiredFixtureIds: requiredFixtureIds(this.deps.fixtures),
        knownEvidenceIds: this.deps.store.knownEvidenceIds(),
        allowedTypes: this.allowedTypes,
        allowedEntityIds: this.deps.registry.list(incident.tenant).map((r) => r.entity_id),
      },
      this.deps.store.knownRepairIds(),
    );

    if (!gate.released) {
      const updated =
        this.deps.store.updateIncident(incident.incident_id, { status: "rejected" }) ?? incident;
      this.postDecision(updated, "Gate blocked release — " + (gate.blockedBy ?? "unknown"), {});
      return {
        incident: updated,
        findings,
        candidates,
        verdicts,
        decision,
        supervisorOverrode: outcome.overrode,
        gate,
        artifact: null,
        detectionToActivationMs: null,
        usage,
      };
    }

    // --- Step 6: issue the artifact and activate the overlay. -----------
    const rid = repairId(incident.incident_id, chosen.payload_hash, overlayVersion);
    const repair: Repair = {
      repair_id: rid,
      type: chosen.type,
      scope: {
        tenant: incident.tenant,
        entity_id: incident.entity_id ?? "",
        session_id: decision.scope.session_id ?? undefined,
      },
      payload: chosen.payload as unknown as Repair["payload"],
      expires: "session_end",
      predecessor: incident.released_repair_id,
    };

    const artifact = issueArtifact({
      repair,
      incidentId: incident.incident_id,
      baseVersion,
      overlayVersion,
      issuedAt: this.deps.clock.now(),
    });

    this.deps.store.putArtifact(artifact);
    this.deps.overlays.release(incident.session_id, artifact);
    if (incident.entity_id) {
      this.deps.registry.recordActiveRepair(incident.tenant, incident.entity_id, rid);
    }

    const updated =
      this.deps.store.updateIncident(incident.incident_id, {
        status: "repairing",
        released_repair_id: rid,
      }) ?? incident;

    const activatedAt = this.deps.clock.now();

    // --- Step 7: durable records, asynchronously. -----------------------
    // Enqueued, not awaited: the overlay above is already live.
    this.enqueueReleaseRecords(updated, artifact, verdicts);

    return {
      incident: updated,
      findings,
      candidates,
      verdicts,
      decision,
      supervisorOverrode: outcome.overrode,
      gate,
      artifact,
      detectionToActivationMs: activatedAt - startedAt,
      usage,
    };
  }

  /* ---------------------------------------------------------------- *
   * Candidate construction
   * ---------------------------------------------------------------- */

  private async buildCandidates(
    incident: Incident,
    commissioned: { experiment: ProposedExperiment }[],
    turn: EvidenceTurn,
    voiceModelVersion: string,
    usage: { renders: number; judgements: number; llmCalls: number },
  ): Promise<Candidate[]> {
    const out: Candidate[] = [];

    for (const { experiment } of commissioned) {

      const hash = payloadHash(experiment.payload);
      const id = candidateId(incident.incident_id, hash);

      let audio: AudioRef | null = null;
      if (experiment.type === "pronunciation" && incident.entity_id) {
        const phonemes = (experiment.payload as { phonemes?: string }).phonemes;
        if (typeof phonemes === "string") {
          const entity = this.deps.registry.get(incident.tenant, incident.entity_id);
          const surface = entity?.canonical_text ?? "";
          const text = turn.intended_text ?? surface;
          audio = await this.deps.renderer.render({
            text,
            segments: surface
              ? [
                  { kind: "text", text: text.slice(0, text.indexOf(surface)) },
                  { kind: "phoneme", display: surface, phonemes, entity_id: incident.entity_id },
                  { kind: "text", text: text.slice(text.indexOf(surface) + surface.length) },
                ]
              : [{ kind: "text", text }],
            voice_model_version: voiceModelVersion,
            cacheKey: id + ":proposal",
          });
          usage.renders += 1;
        }
      }

      out.push({
        candidate_id: id,
        incident_id: incident.incident_id,
        type: experiment.type,
        payload: experiment.payload,
        rationale: experiment.rationale,
        audio,
        payload_hash: hash,
      });
    }

    return out;
  }

  /* ---------------------------------------------------------------- *
   * Observation and rollback (plan §10)
   * ---------------------------------------------------------------- */

  /**
   * Check a newly arrived turn against any repair active for its session.
   *
   * Plan §6C: "After release, synthesize a genuinely new sentence using the
   * repair ... That establishes more than replaying the winning candidate file."
   * This is where that check happens, on the runtime's real next utterance.
   */
  async observe(turn: EvidenceTurn): Promise<ObservationResult[]> {
    const artifacts = this.deps.overlays.activeArtifacts(turn.session_id);
    if (artifacts.length === 0) return [];

    const results: ObservationResult[] = [];

    for (const artifact of artifacts) {
      if (artifact.repair.type !== "pronunciation") continue;
      const entityId = artifact.repair.scope.entity_id;
      const record = this.deps.registry.get(turn.tenant, entityId);
      if (!record?.reference_phonemes) continue;

      // Did this turn actually speak the entity under the repaired version?
      const mentions = turn.entities.some((e) => e.entity_id === entityId);
      if (!mentions) continue;

      const applied = (turn.speech_input ?? []).some(
        (s) => s.kind === "phoneme" && s.entity_id === entityId,
      );

      if (!applied) {
        // The repair was active but the runtime did not apply it. That is a
        // delivery-side problem, not a reason to roll the repair back.
        results.push({
          repairId: artifact.repair_id,
          verified: false,
          detail:
            "Repair " +
            artifact.repair_id +
            " was active but the turn submitted '" +
            entityId +
            "' without the pronunciation override.",
          rolledBack: false,
        });
        continue;
      }

      const audio = await this.audioForTurn(turn);
      if (!audio) {
        results.push({
          repairId: artifact.repair_id,
          verified: false,
          detail: "No generated audio retained; cannot verify the repaired utterance.",
          rolledBack: false,
        });
        continue;
      }

      const assessment = await this.deps.judge.assess({
        candidate: audio,
        referenceAudioId: record.reference_audio_id,
        referencePhonemes: record.reference_phonemes,
        targetSurface: record.canonical_text,
        targetEntityId: entityId,
        neighbouringSurfaces: [],
      });

      if (assessment.match_score >= 0.95) {
        const incident = this.deps.store.getIncident(artifact.incident_id);
        if (incident && incident.status !== "resolved") {
          this.deps.store.updateIncident(incident.incident_id, { status: "resolved" });
          this.enqueueResolve(incident.incident_id, artifact);
        }
        results.push({
          repairId: artifact.repair_id,
          verified: true,
          detail:
            "Fresh utterance under " +
            artifact.base_version +
            "+overlay." +
            artifact.overlay_version +
            " matched the reference (score " +
            assessment.match_score.toFixed(2) +
            ").",
          rolledBack: false,
        });
        continue;
      }

      // Regression on a real repaired utterance: roll back (plan §10).
      const rolled = this.deps.overlays.rollback(turn.session_id, artifact.repair_id);
      this.deps.store.updateIncident(artifact.incident_id, { status: "rolled_back" });
      if (artifact.repair.scope.entity_id) {
        this.deps.registry.quarantine(
          turn.tenant,
          artifact.repair.scope.entity_id,
          "repair " + artifact.repair_id + " regressed on a live utterance",
        );
      }
      this.enqueueRollback(artifact, assessment.match_score);

      results.push({
        repairId: artifact.repair_id,
        verified: false,
        detail:
          "Repaired utterance scored " +
          assessment.match_score.toFixed(2) +
          " against the reference; rolled back to overlay " +
          (rolled?.overlay_version ?? "unknown") +
          ".",
        rolledBack: rolled !== null,
      });
    }

    return results;
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  /**
   * Recover the audio for a turn. Part A posts a URL; the fake renderer needs
   * the phonemes it reported. Re-rendering from the recorded speech_input is
   * faithful because the speech input is exactly what was submitted.
   */
  private async audioForTurn(turn: EvidenceTurn): Promise<AudioRef | null> {
    if (!turn.speech_input || turn.speech_input.length === 0) return null;
    return this.deps.renderer.render({
      text: turn.intended_text ?? "",
      segments: [...turn.speech_input],
      voice_model_version: this.deps.fixtures.voice_model_version,
      cacheKey: "observed:" + turn.session_id + ":" + turn.turn_id + ":" + turn.utterance_id,
    });
  }

  /** Canonical names must not reach Sentry, Slack, or GitHub (plan §3, §15). */
  private sensitiveTerms(tenant: string): string[] {
    return this.deps.registry
      .list(tenant)
      .flatMap((r) => [r.canonical_text, ...r.recognition_hints])
      .filter((s) => s.length > 2);
  }

  private postFindings(incident: Incident, findings: Finding[]): void {
    const slack = this.deps.apps.slack;
    if (!slack) return;
    for (const f of findings) {
      this.deps.queue.enqueue({
        key: "slack:finding:" + incident.incident_id + ":" + f.specialist,
        app: "slack",
        stream: "slack:" + incident.incident_id,
        description: f.specialist + " finding",
        run: () =>
          slack.postFinding(
            incident.incident_id,
            "*" + f.specialist + "* (" + f.layer + "): " + f.hypothesis,
            this.sensitiveTerms(incident.tenant),
          ),
      });
    }
  }

  private postVerdict(incident: Incident, candidate: Candidate, verdict: Verdict): void {
    const slack = this.deps.apps.slack;
    if (!slack) return;
    this.deps.queue.enqueue({
      key: "slack:verdict:" + incident.incident_id + ":" + candidate.candidate_id,
      app: "slack",
      stream: "slack:" + incident.incident_id,
      description: "verdict for " + candidate.candidate_id,
      run: () =>
        slack.postFinding(
          incident.incident_id,
          "*verifier* on `" +
            candidate.candidate_id +
            "`: " +
            (verdict.refuted ? ":x: refuted — " : ":heavy_check_mark: survived — ") +
            verdict.reason,
          this.sensitiveTerms(incident.tenant),
        ),
    });
  }

  private postDecision(incident: Incident, statement: string, links: Record<string, string>): void {
    const slack = this.deps.apps.slack;
    if (!slack) return;
    this.deps.queue.enqueue({
      key: "slack:decision:" + incident.incident_id + ":" + incident.status,
      app: "slack",
      stream: "slack:" + incident.incident_id,
      description: "decision for " + incident.incident_id,
      run: () =>
        slack.postDecision(incident.incident_id, statement, links, this.sensitiveTerms(incident.tenant)),
    });
  }

  private enqueueReleaseRecords(
    incident: Incident,
    artifact: RepairArtifact,
    verdicts: Verdict[],
  ): void {
    const { github } = this.deps.apps;
    if (github) {
      this.deps.queue.enqueue({
        key: "github:manifest:" + artifact.repair_id,
        app: "github",
        description: "commit manifest for " + artifact.repair_id,
        run: () =>
          github.commitManifest({
            incident,
            artifact,
            verdicts,
            sensitive: this.sensitiveTerms(incident.tenant),
          }),
      });
    }
    this.postDecision(incident, "Released " + artifact.repair_id + " into overlay " + artifact.overlay_version + ".", {
      repair_id: artifact.repair_id,
      artifact_hash: artifact.artifact_hash.slice(0, 16),
      overlay: String(artifact.overlay_version),
    });
  }

  private enqueueResolve(incidentIdValue: string, artifact: RepairArtifact): void {
    const { sentry } = this.deps.apps;
    if (!sentry) return;
    this.deps.queue.enqueue({
      key: "sentry:resolve:" + incidentIdValue + ":" + artifact.repair_id,
      app: "sentry",
      stream: "sentry:" + incidentIdValue,
      description: "resolve " + incidentIdValue,
      run: () =>
        sentry.resolveIssue(
          incidentIdValue,
          artifact.base_version + "+overlay." + artifact.overlay_version,
        ),
    });
  }

  private enqueueRollback(artifact: RepairArtifact, score: number): void {
    const { sentry } = this.deps.apps;
    if (!sentry) return;
    this.deps.queue.enqueue({
      key: "sentry:reopen:" + artifact.incident_id + ":" + artifact.repair_id,
      app: "sentry",
      stream: "sentry:" + artifact.incident_id,
      description: "reopen " + artifact.incident_id,
      run: () =>
        sentry.reopenIssue(
          artifact.incident_id,
          "rolled back " + artifact.repair_id + "; repaired utterance scored " + score.toFixed(2),
        ),
    });
  }

  private barrenOutcome(
    incident: Incident,
    reason: string,
    startedAt: number,
    usage: RepairOutcome["usage"],
  ): RepairOutcome {
    void startedAt;
    const updated = this.deps.store.updateIncident(incident.incident_id, { status: "contained" }) ?? incident;
    return {
      incident: updated,
      findings: [],
      candidates: [],
      verdicts: [],
      decision: {
        action: "request_more_evidence",
        chosen_candidate_id: null,
        rejected_candidate_ids: [],
        rationale: reason,
        scope: { tenant: incident.tenant, entity_id: incident.entity_id, session_id: incident.session_id },
      },
      supervisorOverrode: null,
      gate: null,
      artifact: null,
      detectionToActivationMs: null,
      usage,
    };
  }
}
