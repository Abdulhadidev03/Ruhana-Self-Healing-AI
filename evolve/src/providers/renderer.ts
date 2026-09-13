// Candidate renderer.
//
// Evolve renders candidates itself rather than asking the runtime to speak them.
// Plan §8: owning synthesis "allows inaudible candidate rendering without
// opening a second avatar session" — the caller never hears a candidate being
// tried.
//
// Plan §6C requires candidates to be rendered "using the same voice and model as
// the failing output", so voice_model_version is a required field, not an
// option: a candidate verified on a different voice proves nothing about the
// voice that failed.

import type { SpeechSegment } from "../../../contracts/types.ts";
import type { AudioRef } from "../domain/model.ts";

export interface RenderRequest {
  /** Display text; must survive rendering unchanged (plan §6C). */
  text: string;
  /** Speech representation, with the candidate's phonemes already applied. */
  segments: SpeechSegment[];
  /** Pinned to the failing output's voice. */
  voice_model_version: string;
  /** Cache key input; identical requests must not be re-rendered (plan §9). */
  cacheKey: string;
}

export interface CandidateRenderer {
  readonly name: string;
  render(req: RenderRequest): Promise<AudioRef>;
}

/* ------------------------------------------------------------------ */

/**
 * Talks to the local Kokoro worker. Part A runs the same engine for live
 * speech; Evolve uses it out-of-band for candidates.
 *
 * The worker is expected to echo back the phoneme string it actually used, which
 * is what makes local Kokoro stronger evidence than a managed provider here — a
 * hosted API generally cannot tell you what it pronounced.
 */
export class HttpKokoroRenderer implements CandidateRenderer {
  readonly name = "kokoro:http";

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async render(req: RenderRequest): Promise<AudioRef> {
    const res = await this.fetchImpl(this.baseUrl + "/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        segments: req.segments,
        voice_model_version: req.voice_model_version,
      }),
    });
    if (!res.ok) throw new Error("kokoro render failed: " + res.status);
    const body = (await res.json()) as {
      audio_url: string;
      rendered_phonemes?: string | null;
      rendered_tokens?: Record<string, string> | null;
      duration_ms?: number;
    };
    return {
      url: body.audio_url,
      rendered_phonemes: body.rendered_phonemes ?? null,
      rendered_tokens: body.rendered_tokens ?? null,
      duration_ms: body.duration_ms ?? 0,
    };
  }
}

/* ------------------------------------------------------------------ */

/**
 * Deterministic renderer for tests and keyless demo runs.
 *
 * It models the one behaviour that matters for the loop: a word with an explicit
 * phoneme override is pronounced as specified, and a word WITHOUT one falls back
 * to the engine's default grapheme-to-phoneme guess. That fallback is the actual
 * failure mode Part A's injector seeds, so the fake must reproduce it rather
 * than assume plain text sounds correct.
 */
export class FakeRenderer implements CandidateRenderer {
  readonly name = "fake:renderer";
  public renders = 0;
  private cache = new Map<string, AudioRef>();

  /**
   * @param defaultG2P what the engine produces for a bare word — i.e. the wrong
   *        pronunciation for an unusual name.
   */
  constructor(private readonly defaultG2P: Record<string, string> = {}) {}

  async render(req: RenderRequest): Promise<AudioRef> {
    const cached = this.cache.get(req.cacheKey);
    if (cached) return cached;

    this.renders += 1;

    const parts: string[] = [];
    const tokens: Record<string, string> = {};

    for (const seg of req.segments) {
      if (seg.kind === "phoneme") {
        parts.push(seg.phonemes);
        // Keyed by entity id AND by display surface, so a judge can look the
        // word up either way.
        tokens[seg.entity_id] = seg.phonemes;
        tokens[seg.display] = seg.phonemes;
      } else {
        for (const word of seg.text.split(/\s+/).filter(Boolean)) {
          const bare = word.replace(/[^\p{L}\p{N}']/gu, "");
          if (!bare) continue;
          const phon = this.defaultG2P[bare] ?? "/" + bare.toLowerCase() + "/";
          parts.push(phon);
          // Do not let a plain-text occurrence clobber an override.
          if (tokens[bare] === undefined) tokens[bare] = phon;
        }
      }
    }

    const rendered = parts.join(" ");
    const audio: AudioRef = {
      url: "memory://audio/" + req.cacheKey,
      rendered_phonemes: rendered,
      rendered_tokens: tokens,
      duration_ms: Math.max(200, rendered.length * 40),
    };
    this.cache.set(req.cacheKey, audio);
    return audio;
  }

  /** What the fake engine would say for a single word, for assertions. */
  pronounce(word: string): string {
    return this.defaultG2P[word] ?? "/" + word.toLowerCase() + "/";
  }
}
