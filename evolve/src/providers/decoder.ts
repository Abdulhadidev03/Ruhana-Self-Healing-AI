// Independent decoder (plan §6A).
//
// "Run a second decode or audio assessment without showing it the first
// recognizer's answer." The interface takes a URL and nothing else, so the
// primary transcript physically cannot be passed in as a hint.
//
// This matters more than it looks: a decoder given the first answer as context
// will tend to reproduce it, which would turn corroboration into an echo and
// make every recognition incident look confirmed.

import type { IndependentDecoder } from "../agents/specialists.ts";

/** OpenAI transcription. gpt-4o-transcribe and whisper-1 are both available. */
export class OpenAITranscriber implements IndependentDecoder {
  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4o-transcribe",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly loadAudio: (url: string) => Promise<{ bytes: Uint8Array; filename: string }> = defaultLoader,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async decode(micAudioUrl: string): Promise<{ text: string; model: string }> {
    const audio = await this.loadAudio(micAudioUrl);
    const form = new FormData();
    form.append("file", new Blob([audio.bytes as unknown as BlobPart]), audio.filename);
    form.append("model", this.model);
    // Deliberately no `prompt` field: that is where a hint would leak in.

    const res = await this.fetchImpl(this.baseUrl + "/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer " + this.apiKey },
      body: form,
    });
    if (!res.ok) throw new Error("transcribe " + res.status + ": " + (await res.text().catch(() => "")));
    const body = (await res.json()) as { text?: string };
    return { text: body.text ?? "", model: this.model };
  }
}

/** Groq Whisper, the plan's original suggestion. Same contract. */
export class GroqWhisperTranscriber implements IndependentDecoder {
  constructor(
    private readonly apiKey: string,
    private readonly model = "whisper-large-v3",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly loadAudio: (url: string) => Promise<{ bytes: Uint8Array; filename: string }> = defaultLoader,
  ) {}

  async decode(micAudioUrl: string): Promise<{ text: string; model: string }> {
    const audio = await this.loadAudio(micAudioUrl);
    const form = new FormData();
    form.append("file", new Blob([audio.bytes as unknown as BlobPart]), audio.filename);
    form.append("model", this.model);

    const res = await this.fetchImpl("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer " + this.apiKey },
      body: form,
    });
    if (!res.ok) throw new Error("groq transcribe " + res.status);
    const body = (await res.json()) as { text?: string };
    return { text: body.text ?? "", model: this.model };
  }
}

async function defaultLoader(url: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("could not load mic audio: " + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const filename = url.split("/").pop() || "audio.wav";
  return { bytes, filename };
}

/**
 * Deterministic decoder for tests. Maps a URL to a fixed transcript, so a test
 * can stage "the second recognizer heard something different" precisely.
 */
export class ScriptedDecoder implements IndependentDecoder {
  public readonly seen: string[] = [];
  constructor(private readonly table: Record<string, string>, private readonly model = "scripted-decoder") {}

  async decode(micAudioUrl: string): Promise<{ text: string; model: string }> {
    this.seen.push(micAudioUrl);
    const text = this.table[micAudioUrl];
    if (text === undefined) {
      throw new Error("ScriptedDecoder has no transcript for " + micAudioUrl);
    }
    return { text, model: this.model };
  }
}
