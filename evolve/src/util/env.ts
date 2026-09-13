// Minimal .env loader.
//
// Zero-dependency on purpose: Part A's package.json has no runtime deps and the
// project runs under `node --experimental-strip-types`, so pulling in dotenv
// just for this would be the only production dependency in the repo.
//
// Values are never logged. Callers get presence flags, not secrets.

import { existsSync, readFileSync } from "node:fs";

export type Env = Record<string, string>;

export function loadEnv(path = ".env"): Env {
  const env: Env = { ...(process.env as Record<string, string>) };
  if (!existsSync(path)) return env;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real process env wins over the file.
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

/** Which capabilities are live, for the startup banner and the eval report. */
export function capabilities(env: Env) {
  return {
    openai: Boolean(env.OPENAI_API_KEY),
    groq: Boolean(env.GROQ_API_KEY),
    gemini: Boolean(env.GEMINI_API_KEY ?? env.GOOGLE_AI_API_KEY),
    evolveDb: Boolean(env.EVOLVE_SUPABASE_URL && env.EVOLVE_SUPABASE_SERVICE_ROLE_KEY),
    sentry: Boolean(env.SENTRY_DSN && env.SENTRY_AUTH_TOKEN),
    slack: Boolean(env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID),
    github: Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO),
    kokoro: Boolean(env.KOKORO_URL),
  };
}

export function describeCapabilities(env: Env): string {
  const caps = capabilities(env);
  return Object.entries(caps)
    .map(([k, v]) => (v ? "+" : "-") + k)
    .join(" ");
}
