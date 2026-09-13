// Evidence recorder (plan §3 evidence contract): builds one EvidenceTurn per
// utterance and posts it to the Evolve Evidence API. Posting is async and
// retried — the conversation never waits on it (plan §5).

import type {
  DeliveryEvent,
  EntityRef,
  EvidenceTurn,
  SpeechSegment,
  TranscriptResult,
} from "../../contracts/types.ts";

export interface EvidenceSink {
  post(turn: EvidenceTurn): Promise<void>;
}

export class HttpEvidenceSink implements EvidenceSink {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxAttempts = 3,
  ) {}

  async post(turn: EvidenceTurn): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/evidence/turn`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(turn),
        });
        if (res.ok) return;
        lastError = new Error(`evidence post failed: ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, attempt * 200));
    }
    throw lastError;
  }
}

export class TurnEvidenceBuilder {
  private transcript: TranscriptResult | undefined;
  private entities: EntityRef[] = [];
  private intendedText: string | undefined;
  private speechInput: SpeechSegment[] | undefined;
  private micAudioUrl: string | undefined;
  private generatedAudioUrl: string | undefined;
  private deliveryEvents: DeliveryEvent[] = [];
  private injectedFault: string | null = null;

  constructor(
    private readonly ids: {
      tenant: string;
      sessionId: string;
      turnId: string;
      utteranceId: string;
      effectiveVersion: string;
    },
  ) {}

  recordMicAudio(url: string): this {
    this.micAudioUrl = url;
    return this;
  }
  recordTranscript(t: TranscriptResult): this {
    this.transcript = t;
    return this;
  }
  recordEntities(entities: EntityRef[]): this {
    this.entities = entities;
    return this;
  }
  recordIntendedText(text: string): this {
    this.intendedText = text;
    return this;
  }
  recordSpeechInput(segments: SpeechSegment[]): this {
    this.speechInput = segments;
    return this;
  }
  recordGeneratedAudio(url: string): this {
    this.generatedAudioUrl = url;
    return this;
  }
  recordDelivery(event: DeliveryEvent): this {
    this.deliveryEvents.push(event);
    return this;
  }
  recordInjectedFault(label: string | null): this {
    this.injectedFault = label;
    return this;
  }

  build(now: Date = new Date()): EvidenceTurn {
    for (const [name, v] of Object.entries(this.ids)) {
      if (!v) throw new Error(`evidence missing required id: ${name}`);
    }
    return {
      tenant: this.ids.tenant,
      session_id: this.ids.sessionId,
      turn_id: this.ids.turnId,
      utterance_id: this.ids.utteranceId,
      effective_version: this.ids.effectiveVersion,
      mic_audio_url: this.micAudioUrl,
      primary_transcript: this.transcript,
      entities: this.entities,
      intended_text: this.intendedText,
      speech_input: this.speechInput,
      generated_audio_url: this.generatedAudioUrl,
      delivery_events: [...this.deliveryEvents],
      injected_fault: this.injectedFault,
      server_ts: now.toISOString(),
    };
  }
}
