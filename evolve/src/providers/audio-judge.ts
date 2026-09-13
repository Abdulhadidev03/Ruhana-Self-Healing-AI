// Independent acoustic assessment (plan §4, §6C).
//
// Plan §6C is blunt about why this role exists separately from an ASR round
// trip: "recognizers can normalize mispronunciations into the intended
// spelling", so decoding the candidate audio back to text can score a bad
// pronunciation as perfect. The judge looks at the audio against the reference
// instead.
//
// Equally blunt, and reflected in the type: "A general audio model's score is an
// experimental judge, not a calibrated probability of correctness." match_score
// is therefore never compared against a probability threshold anywhere in the
// release path — it is one input to the verifier, which can still refute.

import type { AcousticAssessment, AudioRef } from "../domain/model.ts";

export interface JudgeRequest {
  candidate: AudioRef;
  /** The human reference recording for this entity, when one exists. */
  referenceAudioId: string | null;
  /** Ground-truth phonemes from the reference. */
  referencePhonemes: string | null;
  /** The word under test. */
  targetSurface: string;
  /** Entity id of the word under test, when it is a registered entity. */
  targetEntityId?: string | null;
  /** Other words in the utterance that must not have changed. */
  neighbouringSurfaces: string[];
}

export interface AudioJudge {
  readonly name: string;
  assess(req: JudgeRequest): Promise<AcousticAssessment>;
}

/* ------------------------------------------------------------------ */

/**
 * Gemini audio-capable judge. Sends the candidate audio and asks for a
 * structured comparison against the reference.
 *
 * Note this uses a DIFFERENT model family from the supervisor on purpose: plan
 * §9 warns that "using the same model family to generate and approve audio is
 * weaker evidence than independent evaluation".
 */
export class GeminiAudioJudge implements AudioJudge {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-2.5-flash",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly loadAudio: (url: string) => Promise<{ base64: string; mime: string }> = defaultAudioLoader,
  ) {
    this.name = "gemini:" + model;
  }

  async assess(req: JudgeRequest): Promise<AcousticAssessment> {
    const audio = await this.loadAudio(req.candidate.url);
    const prompt = [
      "You are an acoustic judge for a speech repair system.",
      "Listen to the attached audio and answer ONLY with JSON.",
      "Target word under test: " + JSON.stringify(req.targetSurface),
      req.referencePhonemes
        ? "Reference pronunciation (IPA-like): " + JSON.stringify(req.referencePhonemes)
        : "No reference pronunciation is available; say so rather than guessing.",
      "Other words that must sound unchanged: " + JSON.stringify(req.neighbouringSurfaces),
      "",
      'Reply as {"match_score": 0.0-1.0, "collateral_flags": [words that sound altered], "notes": "one sentence"}.',
      "match_score is your similarity judgement for the TARGET WORD ONLY.",
    ].join("\n");

    const res = await this.fetchImpl(
      "https://generativelanguage.googleapis.com/v1beta/models/" + this.model + ":generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: audio.mime, data: audio.base64 } },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      },
    );

    if (!res.ok) throw new Error("gemini " + res.status + ": " + (await res.text().catch(() => "")));

    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(raw) as {
      match_score?: number;
      collateral_flags?: string[];
      notes?: string;
    };

    return {
      match_score: clamp01(parsed.match_score ?? 0),
      judge_model: this.name,
      collateral_flags: parsed.collateral_flags ?? [],
      notes: parsed.notes ?? "",
    };
  }
}

/**
 * OpenAI audio-capable judge (gpt-audio family).
 *
 * Worth being precise about independence here. Plan §9 warns that "using the
 * same model family to generate and approve audio is weaker evidence than
 * independent evaluation". That warning is about a model grading its OWN
 * output. In this pipeline the audio is rendered by Kokoro, so an OpenAI judge
 * is still independent of the renderer. It would NOT be independent if the
 * renderer were switched to an OpenAI TTS model — at that point this judge must
 * be swapped for Gemini.
 */
export class OpenAIAudioJudge implements AudioJudge {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-audio-1.5",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly loadAudio: (url: string) => Promise<{ base64: string; mime: string }> = defaultAudioLoader,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {
    this.name = "openai:" + model;
  }

  async assess(req: JudgeRequest): Promise<AcousticAssessment> {
    const audio = await this.loadAudio(req.candidate.url);
    const format = audio.mime.includes("mp3") ? "mp3" : "wav";

    const instruction = [
      "You are an acoustic judge for an automated speech-repair system.",
      "Listen to the audio and judge ONLY how the target word is pronounced.",
      "Target word: " + JSON.stringify(req.targetSurface),
      req.referencePhonemes
        ? "Intended reference pronunciation: " + JSON.stringify(req.referencePhonemes)
        : "No reference pronunciation is available. Report match_score 0 and say so in notes rather than guessing.",
      "Words that must sound unchanged: " + JSON.stringify(req.neighbouringSurfaces),
      'Reply ONLY as {"match_score": number 0..1, "collateral_flags": string[], "notes": string}.',
    ].join("\n");

    const res = await this.fetchImpl(this.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + this.apiKey },
      body: JSON.stringify({
        model: this.model,
        modalities: ["text"],
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: instruction },
              { type: "input_audio", input_audio: { data: audio.base64, format } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) throw new Error("openai audio " + res.status + ": " + (await res.text().catch(() => "")));

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as {
      match_score?: number;
      collateral_flags?: string[];
      notes?: string;
    };

    return {
      match_score: clamp01(parsed.match_score ?? 0),
      judge_model: this.name,
      collateral_flags: parsed.collateral_flags ?? [],
      notes: parsed.notes ?? "",
    };
  }
}

async function defaultAudioLoader(url: string): Promise<{ base64: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("could not load candidate audio: " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mime: res.headers.get("content-type") ?? "audio/wav" };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/* ------------------------------------------------------------------ */

/**
 * Deterministic stand-in for tests and for demo runs without a Gemini key.
 *
 * IMPORTANT, and stated plainly because the plan insists on this kind of
 * honesty: this performs NO acoustic analysis. It compares the phoneme string
 * the renderer self-reported against the reference phoneme string. That is a
 * valid way to test the ORCHESTRATION — does a good candidate survive, does a
 * bad one get refuted — and it is not evidence that real audio was judged.
 * Swapping in GeminiAudioJudge is what makes the acoustic claim real.
 */
export class PhonemeMatchJudge implements AudioJudge {
  readonly name = "fake:phoneme-match";

  /** Surfaces whose audio this judge should report as collaterally altered. */
  constructor(private readonly collateralRule: (req: JudgeRequest) => string[] = () => []) {}

  async assess(req: JudgeRequest): Promise<AcousticAssessment> {
    // Assess the TARGET WORD, not the whole utterance. Falling back to the
    // full string would score a correct candidate in a long sentence near zero.
    const tokens = req.candidate.rendered_tokens;
    const rendered =
      (req.targetEntityId ? tokens?.[req.targetEntityId] : undefined) ??
      tokens?.[req.targetSurface] ??
      (tokens ? null : req.candidate.rendered_phonemes);
    const reference = req.referencePhonemes;

    if (reference === null) {
      return {
        match_score: 0,
        judge_model: this.name,
        collateral_flags: [],
        notes: "No reference pronunciation available; cannot assess. Abstaining rather than guessing.",
      };
    }
    if (rendered === null) {
      return {
        match_score: 0,
        judge_model: this.name,
        collateral_flags: [],
        notes:
          "The renderer reported no phonemes for '" +
          req.targetSurface +
          "' and this judge cannot analyse audio; a real acoustic judge is required here.",
      };
    }

    const score = similarity(rendered, reference);
    return {
      match_score: score,
      judge_model: this.name,
      collateral_flags: this.collateralRule(req),
      notes:
        score >= 0.99
          ? "Rendered phonemes match the reference exactly."
          : "Rendered '" + rendered + "' differs from reference '" + reference + "'.",
    };
  }
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  let distance = 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const t = prev;
    prev = curr;
    curr = t;
  }
  distance = prev[n]!;
  return Math.max(0, 1 - distance / longer);
}
