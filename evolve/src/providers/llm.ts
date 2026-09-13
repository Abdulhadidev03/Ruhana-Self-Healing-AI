// Language-model provider.
//
// Two implementations:
//   GroqLLM  — the real supervisor/specialist backend (plan §4 suggests
//              GPT-OSS-120B on Groq). Activated by GROQ_API_KEY.
//   ScriptedLLM — deterministic stand-in used by every test and by the demo
//              when no key is present.
//
// Honest labelling matters here. ScriptedLLM does not reason; it returns fixed
// structured answers so the ORCHESTRATION can be tested without a network. A
// green test suite therefore proves the loop is correct, not that a model
// diagnoses well. Those are different claims and the eval report says so.

export interface LlmRequest {
  system: string;
  user: string;
  /** Caller-declared budget. Plan §9: separate supervisor and worker budgets. */
  maxTokens?: number;
  temperature?: number;
  /** Stable label used for caching and for the ScriptedLLM routing table. */
  task: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  /** null when the provider does not report usage. */
  tokensUsed: number | null;
}

export interface LLM {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/* ------------------------------------------------------------------ */

export class GroqLLM implements LLM {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model = "openai/gpt-oss-120b",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.groq.com/openai/v1",
  ) {
    this.name = "groq:" + model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.fetchImpl(this.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.apiKey,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 800,
        response_format: { type: "json_object" },
      }),
    });

    if (res.status === 429) {
      // Plan §9: honor rate limits, preserve the incident, retry later — never
      // spin in an unbounded self-improvement loop.
      throw new RateLimited("groq rate limit on task '" + req.task + "'");
    }
    if (!res.ok) {
      throw new Error("groq " + res.status + ": " + (await res.text().catch(() => "")));
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    return { text, model: this.model, tokensUsed: body.usage?.total_tokens ?? null };
  }
}

export class RateLimited extends Error {}

/* ------------------------------------------------------------------ */

/**
 * OpenAI provider, on the Responses API.
 *
 * The gpt-5.x family takes `reasoning.effort` rather than `temperature`, so this
 * is not interchangeable with the chat/completions shape used by GroqLLM.
 * Verified against the account in use: gpt-5.6-luna and gpt-5.6-terra both
 * answer with text.format json_object.
 *
 * Model assignment follows plan §9's "separate supervisor and worker model
 * budgets": the heavier model supervises, the faster one runs specialists.
 */
export class OpenAILLM implements LLM {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly effort: "minimal" | "low" | "medium" | "high" = "low",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {
    this.name = "openai:" + model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.fetchImpl(this.baseUrl + "/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.apiKey,
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        reasoning: { effort: this.effort },
        text: { format: { type: "json_object" } },
        // Reasoning tokens are billed against this ceiling too, so it must be
        // comfortably above the visible answer length or the reply comes back
        // empty with status "incomplete".
        max_output_tokens: Math.max(req.maxTokens ?? 800, 1500),
      }),
    });

    if (res.status === 429) {
      throw new RateLimited("openai rate limit on task '" + req.task + "'");
    }
    if (!res.ok) {
      throw new Error("openai " + res.status + ": " + (await res.text().catch(() => "")));
    }

    const body = (await res.json()) as {
      output?: { content?: { text?: string }[] }[];
      usage?: { total_tokens?: number };
      status?: string;
    };

    const text = (body.output ?? [])
      .flatMap((o) => o.content ?? [])
      .map((c) => c.text)
      .filter((t): t is string => typeof t === "string")
      .join("");

    if (!text) {
      throw new Error(
        "openai returned no text for task '" + req.task + "' (status " + (body.status ?? "unknown") + "); raise max_output_tokens",
      );
    }

    return { text, model: this.model, tokensUsed: body.usage?.total_tokens ?? null };
  }
}

/* ------------------------------------------------------------------ */

/**
 * Deterministic stand-in. Routes on LlmRequest.task and returns a canned JSON
 * string. Unknown tasks throw rather than silently returning "{}" — a silent
 * empty answer would look like a working agent that found nothing.
 */
export class ScriptedLLM implements LLM {
  readonly name = "scripted";
  public readonly calls: LlmRequest[] = [];

  constructor(private readonly responses: Record<string, (req: LlmRequest) => string>) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const handler = this.responses[req.task];
    if (!handler) {
      throw new Error(
        "ScriptedLLM has no response for task '" + req.task + "'. Known tasks: " + Object.keys(this.responses).join(", "),
      );
    }
    return { text: handler(req), model: "scripted", tokensUsed: null };
  }
}

/**
 * Parse a model's JSON reply defensively. Models wrap JSON in prose or fences
 * often enough that a bare JSON.parse is a real source of flakiness.
 */
export function parseJsonReply<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model reply: " + text.slice(0, 200));
  }
  return JSON.parse(body.slice(start, end + 1)) as T;
}
