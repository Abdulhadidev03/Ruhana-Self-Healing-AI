// TTS seam: Kokoro over HTTP for the real path, a deterministic mock for tests.
// The engine consumes speech segments — phoneme segments render from phonemes,
// keeping display text independent of speech representation (plan §8).

import type { SpeechSegment } from "../../../contracts/types.ts";

export interface SynthesisResult {
  pcm: Int16Array;
  sampleRate: number;
  voiceModelVersion: string;
}

export interface TTSEngine {
  synthesize(segments: readonly SpeechSegment[]): Promise<SynthesisResult>;
}

/** Talks to a local Kokoro worker (see runtime/workers/README). */
export class KokoroHttpEngine implements TTSEngine {
  constructor(
    private readonly baseUrl: string,
    private readonly voice: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async synthesize(segments: readonly SpeechSegment[]): Promise<SynthesisResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: this.voice, segments }),
    });
    if (!res.ok) throw new Error(`kokoro worker error: ${res.status}`);
    const meta = JSON.parse(res.headers.get("x-synthesis-meta") ?? "{}");
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      pcm: new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2)),
      sampleRate: Number(meta.sample_rate ?? 24000),
      voiceModelVersion: String(meta.voice_model_version ?? "kokoro-unknown"),
    };
  }
}

/**
 * Deterministic test engine: encodes each segment's spoken form into samples so
 * tests can assert WHICH pronunciation was rendered without real audio.
 */
export class MockTTSEngine implements TTSEngine {
  readonly rendered: string[] = [];

  async synthesize(segments: readonly SpeechSegment[]): Promise<SynthesisResult> {
    const spoken = segments
      .map((s) => (s.kind === "phoneme" ? `[${s.phonemes}]` : s.text))
      .join("");
    this.rendered.push(spoken);
    const pcm = new Int16Array(Math.max(1, spoken.length * 10));
    for (let i = 0; i < spoken.length; i++) pcm[i] = spoken.charCodeAt(i);
    return { pcm, sampleRate: 24000, voiceModelVersion: "mock-voice-1" };
  }
}
