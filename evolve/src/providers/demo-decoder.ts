// Decoder for the synthetic demo tenant.
//
// The demo's evidence carries mic URLs like "memory://mic/t-1" — there is no
// file behind them, because Part A's capture is not wired up yet. A real
// transcriber given one of those fails, and the perception specialist correctly
// abstains: "the independent decode failed, so the primary transcript is
// unverified."
//
// That abstention is honest but it is also the wrong thing to demonstrate. Plan
// §12 step 3 wants perception to actually DO its job — run a second decode and
// report that it found no input-recognition cause — which it cannot do with no
// audio to decode.
//
// So: synthetic mic segments get a scripted second decode, and anything with a
// real URL is delegated to the real transcriber. The demo tenant is synthetic
// throughout (plan §15 asks for synthetic entities), so a synthetic transcript
// is no more of a stand-in than the entities already are. The moment Part A
// posts a real mic_audio_url, that path takes over and nothing here applies.

import type { IndependentDecoder } from "../agents/specialists.ts";

export class DemoDecoder implements IndependentDecoder {
  constructor(
    /** Scripted second decodes, keyed by the synthetic mic URL. */
    private readonly synthetic: Record<string, string>,
    /** Used for any URL that is not synthetic. */
    private readonly real: IndependentDecoder | null,
    private readonly syntheticModel = "demo-second-decoder (synthetic)",
  ) {}

  async decode(micAudioUrl: string): Promise<{ text: string; model: string }> {
    const scripted = this.synthetic[micAudioUrl];
    if (scripted !== undefined) {
      return { text: scripted, model: this.syntheticModel };
    }

    if (micAudioUrl.startsWith("memory://")) {
      // A synthetic URL we have no script for. Failing loudly is better than
      // inventing a transcript for audio nobody recorded.
      throw new Error("no synthetic transcript registered for " + micAudioUrl);
    }

    if (!this.real) {
      throw new Error("no real decoder configured for " + micAudioUrl);
    }
    return this.real.decode(micAudioUrl);
  }
}
