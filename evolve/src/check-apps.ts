// Credential checker:  npm run evolve:check
//
// Verifies the Sentry, Slack and GitHub credentials in .env actually work,
// BEFORE a demo depends on them. Every check here is read-only — it confirms
// identity and access without creating an issue, posting a message or making a
// commit. The first real incident is what exercises the write paths.
//
// Each check reports exactly which scope is missing when it fails, so a 403 is
// actionable rather than mysterious.

import { loadEnv, type Env } from "./util/env.ts";
import { parseDsn } from "./apps/connectors.ts";

type Status = "ok" | "missing" | "failed";

interface Check {
  app: string;
  status: Status;
  detail: string;
  fix: string;
}

const results: Check[] = [];

function add(app: string, status: Status, detail: string, fix = ""): void {
  results.push({ app, status, detail, fix });
}

/* ------------------------------------------------------------------ *
 * Sentry
 * ------------------------------------------------------------------ */

async function checkSentry(env: Env): Promise<void> {
  const { SENTRY_DSN, SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT } = env;

  if (!SENTRY_DSN) {
    add("sentry:dsn", "missing", "SENTRY_DSN not set", "Project Settings -> Client Keys (DSN)");
  } else {
    try {
      const parsed = parseDsn(SENTRY_DSN);
      add("sentry:dsn", "ok", "project id " + parsed.projectId + ", ingest " + new URL(parsed.endpoint).host);
    } catch {
      add("sentry:dsn", "failed", "DSN is malformed", "Expect https://<key>@<host>/<projectId>");
    }
  }

  if (!SENTRY_AUTH_TOKEN || !SENTRY_ORG || !SENTRY_PROJECT) {
    add(
      "sentry:api",
      "missing",
      "need SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT",
      "Without these Evolve can OPEN issues but not resolve or reopen them.",
    );
    return;
  }

  try {
    const res = await fetch(
      "https://sentry.io/api/0/projects/" +
        encodeURIComponent(SENTRY_ORG) +
        "/" +
        encodeURIComponent(SENTRY_PROJECT) +
        "/",
      { headers: { authorization: "Bearer " + SENTRY_AUTH_TOKEN } },
    );

    if (res.status === 401) {
      add("sentry:api", "failed", "401 — token rejected", "Token is wrong or revoked.");
    } else if (res.status === 403) {
      add("sentry:api", "failed", "403 — token lacks scope", "Needs project:read and event:admin.");
    } else if (res.status === 404) {
      add(
        "sentry:api",
        "failed",
        "404 — org/project not found",
        "Check SENTRY_ORG is the org SLUG (from the URL), not the display name.",
      );
    } else if (!res.ok) {
      add("sentry:api", "failed", "HTTP " + res.status, "");
    } else {
      const body = (await res.json()) as { slug?: string; name?: string };
      add("sentry:api", "ok", "project '" + (body.slug ?? SENTRY_PROJECT) + "' reachable, token valid");
    }
  } catch (err) {
    add("sentry:api", "failed", "network error: " + String(err), "");
  }
}

/* ------------------------------------------------------------------ *
 * Slack
 * ------------------------------------------------------------------ */

async function checkSlack(env: Env): Promise<void> {
  const { SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } = env;

  if (!SLACK_BOT_TOKEN) {
    add("slack:token", "missing", "SLACK_BOT_TOKEN not set", "OAuth & Permissions -> Bot User OAuth Token (xoxb-)");
    return;
  }
  if (!SLACK_BOT_TOKEN.startsWith("xoxb-")) {
    add(
      "slack:token",
      "failed",
      "token does not start with xoxb-",
      "You may have copied the User token (xoxp-) or the App-level token (xapp-).",
    );
  }

  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: "Bearer " + SLACK_BOT_TOKEN },
    });
    const body = (await res.json()) as { ok?: boolean; team?: string; user?: string; error?: string };
    if (!body.ok) {
      add("slack:token", "failed", "auth.test: " + (body.error ?? "unknown"), "");
      return;
    }
    add("slack:token", "ok", "bot '" + (body.user ?? "?") + "' in workspace '" + (body.team ?? "?") + "'");
  } catch (err) {
    add("slack:token", "failed", "network error: " + String(err), "");
    return;
  }

  if (!SLACK_CHANNEL_ID) {
    add("slack:channel", "missing", "SLACK_CHANNEL_ID not set", "Channel details -> Channel ID (starts with C)");
    return;
  }

  try {
    const res = await fetch(
      "https://slack.com/api/conversations.info?channel=" + encodeURIComponent(SLACK_CHANNEL_ID),
      { headers: { authorization: "Bearer " + SLACK_BOT_TOKEN } },
    );
    const body = (await res.json()) as {
      ok?: boolean;
      error?: string;
      channel?: { name?: string; is_member?: boolean; is_private?: boolean };
    };

    if (!body.ok) {
      const hint =
        body.error === "missing_scope"
          ? "Add channels:read (public) or groups:read (private) to verify. Posting only needs chat:write."
          : body.error === "channel_not_found"
            ? "Wrong channel ID, or the bot cannot see that channel."
            : "";
      add("slack:channel", "failed", body.error ?? "unknown", hint);
      return;
    }

    const ch = body.channel ?? {};
    if (ch.is_member === false) {
      add(
        "slack:channel",
        "failed",
        "#" + (ch.name ?? "?") + " found, but the bot is NOT a member",
        "In Slack, run: /invite @<your bot name> in that channel.",
      );
    } else {
      add("slack:channel", "ok", "#" + (ch.name ?? "?") + (ch.is_private ? " (private)" : "") + ", bot is a member");
    }
  } catch (err) {
    add("slack:channel", "failed", "network error: " + String(err), "");
  }
}

/* ------------------------------------------------------------------ *
 * GitHub
 * ------------------------------------------------------------------ */

async function checkGithub(env: Env): Promise<void> {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH } = env;

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    add("github", "missing", "need GITHUB_TOKEN + GITHUB_REPO", "GITHUB_REPO is 'owner/repo'.");
    return;
  }
  if (!GITHUB_REPO.includes("/")) {
    add("github", "failed", "GITHUB_REPO must be 'owner/repo'", "e.g. Abdulhadidev03/ruhana-evolve-demo");
    return;
  }

  const headers = {
    accept: "application/vnd.github+json",
    authorization: "Bearer " + GITHUB_TOKEN,
    "x-github-api-version": "2022-11-28",
  };

  try {
    const res = await fetch("https://api.github.com/repos/" + GITHUB_REPO, { headers });

    if (res.status === 401) {
      add("github:repo", "failed", "401 — token rejected", "Token wrong, expired, or not yet approved.");
      return;
    }
    if (res.status === 404) {
      add(
        "github:repo",
        "failed",
        "404 — repo not visible to this token",
        "Fine-grained PAT: confirm this repo is in 'Only select repositories'.",
      );
      return;
    }
    if (!res.ok) {
      add("github:repo", "failed", "HTTP " + res.status, "");
      return;
    }

    const body = (await res.json()) as {
      full_name?: string;
      default_branch?: string;
      permissions?: { push?: boolean };
      private?: boolean;
    };

    add(
      "github:repo",
      "ok",
      (body.full_name ?? GITHUB_REPO) +
        (body.private ? " (private)" : " (public)") +
        ", default branch " +
        (body.default_branch ?? "?"),
    );

    if (body.permissions?.push === false) {
      add(
        "github:write",
        "failed",
        "token is read-only",
        "Fine-grained PAT needs Repository permissions -> Contents: Read and write.",
      );
    } else {
      add("github:write", "ok", "Contents write permission present");
    }

    const branch = GITHUB_BRANCH || body.default_branch || "main";
    const br = await fetch(
      "https://api.github.com/repos/" + GITHUB_REPO + "/branches/" + encodeURIComponent(branch),
      { headers },
    );
    if (br.ok) {
      add("github:branch", "ok", "branch '" + branch + "' exists");
    } else {
      add(
        "github:branch",
        "failed",
        "branch '" + branch + "' not found (HTTP " + br.status + ")",
        "Initialise the repo with a README so the branch exists.",
      );
    }
  } catch (err) {
    add("github:repo", "failed", "network error: " + String(err), "");
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const env = loadEnv();

  console.log("Checking external app credentials from .env (read-only checks)\n");

  await Promise.all([checkSentry(env), checkSlack(env), checkGithub(env)]);

  const width = Math.max(...results.map((r) => r.app.length));
  const icon = { ok: "  OK  ", missing: " MISS ", failed: " FAIL " };

  for (const r of results.sort((a, b) => a.app.localeCompare(b.app))) {
    console.log("[" + icon[r.status] + "] " + r.app.padEnd(width) + "  " + r.detail);
    if (r.fix) console.log(" ".repeat(width + 12) + "-> " + r.fix);
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const missing = results.filter((r) => r.status === "missing").length;

  console.log(
    "\n" + ok + " ok, " + failed + " failed, " + missing + " missing.",
  );

  if (failed === 0 && missing === 0) {
    console.log("All three apps are ready. Run: npm run evolve:demo -- --live");
  } else {
    console.log(
      "Evolve runs regardless — a missing app means that record is simply not written,\nnever a blocked repair (plan §11).",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
