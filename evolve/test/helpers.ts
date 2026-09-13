// Test helpers: a recording fetch that impersonates Sentry, Slack and GitHub.
//
// This is what lets the end-to-end test assert on the three external app
// records without holding real credentials. Every request is captured verbatim,
// so the test checks the actual URL, method, headers and body that would reach
// the live APIs — not a summary of them.

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface RecordingFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  byApp(app: "sentry" | "slack" | "github"): RecordedRequest[];
  reset(): void;
}

function classify(url: string): "sentry" | "slack" | "github" | "other" {
  if (url.includes("sentry.io")) return "sentry";
  if (url.includes("slack.com")) return "slack";
  if (url.includes("api.github.com")) return "github";
  return "other";
}

export function recordingFetch(
  options: { failFor?: (url: string) => boolean; githubExisting?: Record<string, string> } = {},
): RecordingFetch {
  const requests: RecordedRequest[] = [];
  let slackTs = 1000;

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body;
    let body: unknown = null;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    requests.push({
      url,
      method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ]),
      ),
      body,
    });

    if (options.failFor?.(url)) {
      return new Response("simulated outage", { status: 503 });
    }

    const kind = classify(url);

    if (kind === "slack") {
      slackTs += 1;
      return Response.json({ ok: true, ts: String(slackTs) + ".000100", channel: "C000TEST" });
    }

    if (kind === "sentry") {
      // Model the real two-step shape: /store/ ingests, the project issues
      // endpoint SEARCHES (array), and /issues/{id}/ updates one issue. A mock
      // that answered every Sentry call with one object would hide the fact
      // that the connector has to resolve an id before it can mutate.
      if (url.includes("/store/")) return Response.json({ id: "sentry-event-1" });
      if (method === "GET" && url.includes("/issues/")) {
        return Response.json([{ id: "7730203040", status: "unresolved" }]);
      }
      if (method === "PUT") {
        return Response.json({
          id: "7730203040",
          permalink: "https://sentry.io/issues/7730203040/",
        });
      }
      return Response.json({});
    }

    if (kind === "github") {
      if (method === "GET") {
        const path = url.split("/contents/")[1]?.split("?")[0] ?? "";
        const existing = options.githubExisting?.[path];
        if (existing === undefined) return new Response("not found", { status: 404 });
        return Response.json({
          sha: "existing-sha",
          content: Buffer.from(existing, "utf8").toString("base64"),
        });
      }
      return Response.json({ commit: { sha: "commit-sha-1" }, content: { path: "ok" } });
    }

    return Response.json({ ok: true });
  }) as unknown as typeof fetch;

  return {
    fetch: impl,
    requests,
    byApp: (app) => requests.filter((r) => classify(r.url) === app),
    reset: () => {
      requests.length = 0;
    },
  };
}
