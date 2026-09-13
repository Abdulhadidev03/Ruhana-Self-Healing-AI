// Turn controller: pins each turn to a version snapshot, applies staged repairs
// only at turn boundaries, and enforces turn epochs so a reply built from
// superseded state is never delivered (plan §6D / §10).

import type { EntityRef, EvidenceTurn } from "../../contracts/types.ts";
import { SessionOverlayStore, type VersionSnapshot } from "./overlay.ts";
import { buildSpeechInput } from "./speech-input.ts";
import { FailureInjector } from "./failure-injector.ts";
import type { TTSEngine } from "./tts/engine.ts";
import type { EvidenceSink } from "./evidence.ts";
import { TurnEvidenceBuilder } from "./evidence.ts";

export interface BrainResponse {
  intendedText: string;
  entities: EntityRef[];
}

export interface DeliveredUtterance {
  turnId: string;
  utteranceId: string;
  effectiveVersion: string;
  pcm: Int16Array;
  sampleRate: number;
  spokenSegments: ReturnType<typeof buildSpeechInput>;
}

export interface TurnResult {
  status: "delivered" | "superseded";
  utterance?: DeliveredUtterance;
  evidence: EvidenceTurn;
}

export class TurnController {
  private epoch = 0;
  private turnCounter = 0;

  constructor(
    private readonly tenant: string,
    private readonly sessionId: string,
    private readonly overlay: SessionOverlayStore,
    private readonly tts: TTSEngine,
    private readonly evidenceSink: EvidenceSink,
    readonly injector: FailureInjector = new FailureInjector(),
  ) {}

  /** Interruption or a superseding user turn bumps the epoch. */
  interrupt(): void {
    this.epoch++;
  }

  currentEpoch(): number {
    return this.epoch;
  }

  /**
   * Run one assistant turn. `brain` is any async producer of the intended
   * response (the real Ruhana brain endpoint, or a stub in tests).
   */
  async runTurn(brain: () => Promise<BrainResponse>): Promise<TurnResult> {
    // Turn boundary: staged repairs become active before this turn snapshots.
    this.overlay.applyAtTurnBoundary();
    const snapshot: VersionSnapshot = this.overlay.snapshot();
    const startEpoch = ++this.epoch;
    const turnId = `t-${++this.turnCounter}`;
    const utteranceId = `${turnId}-u1`;

    const builder = new TurnEvidenceBuilder({
      tenant: this.tenant,
      sessionId: this.sessionId,
      turnId,
      utteranceId,
      effectiveVersion: snapshot.effectiveVersion,
    });
    builder.recordInjectedFault(this.injector.activeFault()?.label ?? null);

    const response = await brain();
    builder.recordIntendedText(response.intendedText).recordEntities(response.entities);

    const scopedRepairs = response.entities.flatMap((e) =>
      this.overlay.repairsForEntity(snapshot, e.entity_id),
    );
    const effectiveRepairs = this.injector.filterRepairs(scopedRepairs);
    const segments = buildSpeechInput(response.intendedText, response.entities, effectiveRepairs);
    builder.recordSpeechInput(segments);

    const synthesis = await this.tts.synthesize(segments);

    // Stale-response protection: if the epoch moved while we were generating,
    // this utterance is superseded and must not reach the voice stream.
    if (this.epoch !== startEpoch) {
      builder.recordDelivery({ type: "superseded", client_ts: Date.now() });
      const evidence = builder.build();
      void this.postEvidence(evidence);
      return { status: "superseded", evidence };
    }

    builder.recordDelivery({ type: "passthrough_submitted", client_ts: Date.now() });
    const evidence = builder.build();
    void this.postEvidence(evidence);

    return {
      status: "delivered",
      utterance: {
        turnId,
        utteranceId,
        effectiveVersion: snapshot.effectiveVersion,
        pcm: synthesis.pcm,
        sampleRate: synthesis.sampleRate,
        spokenSegments: segments,
      },
      evidence,
    };
  }

  private async postEvidence(evidence: EvidenceTurn): Promise<void> {
    try {
      await this.evidenceSink.post(evidence);
    } catch {
      // Evidence delivery must never break the conversation; the sink retries
      // internally and a terminal failure is contained here (plan §5).
    }
  }
}
