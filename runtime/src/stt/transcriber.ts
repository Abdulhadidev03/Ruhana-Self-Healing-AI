// STT seam: Groq Whisper for the real path, a scripted mock for tests.
// The mic track is transcribed on its own — never the mixed stream, or the
// system can interpret its own voice as the customer (plan §3).

import type { TranscriptResult } from "../../../contracts/types.ts";

export interface Transcriber {
  transcribe(audio: Blob | Uint8Array, opts?: { prompt?: string }): Promise<TranscriptResult>;
}

export class GroqWhisperTranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly model = "whisper-large-v3-turbo",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Blob | Uint8Array, opts?: { prompt?: string }): Promise<TranscriptResult> {
    const form = new FormData();
    const blob = audio instanceof Blob
      ? audio
      : new Blob([new Uint8Array(audio)], { type: "audio/wav" });
    form.append("file", blob, "clip.wav");
    form.append("model", this.model);
    // A transcription prompt is a hint, not a forced guarantee (plan §6A).
    if (opts?.prompt) form.append("prompt", opts.prompt);

    const res = await this.fetchImpl("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`groq stt error: ${res.status}`);
    const json = (await res.json()) as { text: string };
    return { text: json.text, model: this.model };
  }
}

export class MockTranscriber implements Transcriber {
  private queue: string[] = [];

  enqueue(text: string): void {
    this.queue.push(text);
  }

  async transcribe(): Promise<TranscriptResult> {
    const text = this.queue.shift();
    if (text === undefined) throw new Error("MockTranscriber: no scripted transcript");
    return { text, model: "mock-stt-1" };
  }
}
