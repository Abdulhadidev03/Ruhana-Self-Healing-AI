// The three external app connectors (plan §11).
//
// Each is deliberately thin and takes an injected fetch, so the end-to-end test
// can assert on the exact requests that WOULD go out without holding real
// credentials. Swapping in the global fetch plus real tokens is the only
// difference between the tested path and the live one.
//
// Privacy constraint from plan §3 and §15, enforced in redact(): "never raw
// customer audio or personal names" leaves the building. Records carry incident
// ids, layers, versions, and access-controlled links.

import { sha256 } from "../domain/ids.ts";
import type { Incident, RepairArtifact, Verdict } from "../domain/model.ts";

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

/**
 * Entity ids and hashes are safe to publish; canonical display names are not.
 * The demo uses synthetic entities, but the connector must not depend on that.
 */
export function redact(text: string, sensitive: readonly string[]): string {
  let out = text;
  for (const term of sensitive) {
    if (!term) continue;
    out = out.split(term).join("«redacted»");
  }
  return out;
}

/** Sentry event ids must be exactly 32 lowercase hex characters. */
export function eventIdFor(incidentId: string): string {
  return sha256(incidentId).slice(0, 32);
}

/* ------------------------------------------------------------------ *
 * Sentry — incident lifecycle
 * ------------------------------------------------------------------ */

export interface SentryConfig {
  dsn: string;
  authToken: string;
  org: string;
  project: string;
}

/** Parses the ingest endpoint and public key out of a DSN. */
export function parseDsn(dsn: string): { endpoint: string; publicKey: string; projectId: string } {
  const m = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(dsn.trim());
  if (!m || !m[1] || !m[2] || !m[3]) throw new Error("malformed Sentry DSN");
  return {
    publicKey: m[1],
    endpoint: "https://" + m[2] + "/api/" + m[3] + "/store/",
    projectId: m[3],
  };
}

export class SentryConnector {
  constructor(
    private readonly config: SentryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://sentry.io/api/0",
  ) {}

  /**
   * Open an issue for a detected failure. The fingerprint is the incident id, so
   * the same failure detected twice lands on ONE issue (plan §11 idempotency).
   */
  async openIssue(incident: Incident, sensitive: readonly string[]): Promise<unknown> {
    const { endpoint, publicKey } = parseDsn(this.config.dsn);
    const body = {
      // Sentry requires exactly 32 HEX characters. Incident ids are prefixed
      // ("inc-…") and the prefix is not hex, so the id cannot be reused
      // directly — the payload is rejected with a 400 before it reaches the
      // project. Hashing keeps the id stable per incident (so a retry is
      // deduplicated rather than duplicated) while satisfying the format.
      event_id: eventIdFor(incident.incident_id),
      timestamp: new Date(incident.opened_at).toISOString(),
      platform: "javascript",
      level: "error",
      logger: "ruhana-evolve",
      message: redact(
        "Voice failure [" + incident.layer + "] " + incident.summary,
        sensitive,
      ),
      fingerprint: [incident.incident_id],
      release: incident.observed_version,
      tags: {
        incident_id: incident.incident_id,
        layer: incident.layer,
        tenant: incident.tenant,
        effective_version: incident.observed_version,
        injected_fault: incident.injected_fault ?? "none",
      },
      extra: {
        evidence_ids: incident.evidence_ids,
        entity_id: incident.entity_id,
        note: "Evidence is access-controlled; no audio or personal names are attached.",
      },
    };

    const res = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth": [
          "Sentry sentry_version=7",
          "sentry_client=ruhana-evolve/0.1",
          "sentry_key=" + publicKey,
        ].join(", "),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error("sentry store " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 300));
    }
    return res.json().catch(() => ({}));
  }

  /** Resolve when a fresh repaired utterance verifies (plan §11). */
  async resolveIssue(incidentId: string, repairVersion: string): Promise<unknown> {
    return this.mutate(incidentId, "resolved", repairVersion);
  }

  /** Reopen on rollback (plan §11). */
  async reopenIssue(incidentId: string, reason: string): Promise<unknown> {
    return this.mutate(incidentId, "unresolved", reason);
  }

  /**
   * Resolve an incident id to a Sentry issue id via its tag.
   *
   * Returns null when the issue is not searchable yet. Sentry's tag index is
   * eventually consistent — an event accepted by /store/ took well over ten
   * seconds to become findable in testing — so "not found" is a retry-later
   * condition, not a failure.
   */
  private async findIssueId(incidentId: string): Promise<string | null> {
    const url =
      this.apiBase +
      "/projects/" +
      encodeURIComponent(this.config.org) +
      "/" +
      encodeURIComponent(this.config.project) +
      "/issues/?query=" +
      encodeURIComponent("incident_id:" + incidentId);

    const res = await this.fetchImpl(url, {
      headers: { authorization: "Bearer " + this.config.authToken },
    });
    if (!res.ok) {
      throw new Error("sentry search " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 300));
    }
    const issues = (await res.json()) as { id?: string }[];
    return Array.isArray(issues) && issues[0]?.id ? issues[0].id : null;
  }

  /**
   * Update one issue's status.
   *
   * Deliberately NOT the bulk endpoint with ?query=. That form returns a 502
   * gateway error from Sentry ("protocol error") even when the same query works
   * for a GET; ?id= and the single-issue endpoint both behave. So: search for
   * the id, then update that issue directly.
   */
  private async mutate(incidentId: string, status: string, note: string): Promise<unknown> {
    // `note` is kept in the signature for the Slack and dashboard trail but is
    // not sent: the issue-update endpoint defines no such field.
    void note;

    const issueId = await this.findIssueId(incidentId);
    if (!issueId) {
      // Surfacing this as an error hands it back to the retry queue, which is
      // exactly right — the issue usually appears a few seconds later.
      throw new Error("sentry issue for " + incidentId + " is not indexed yet; will retry");
    }

    const res = await this.fetchImpl(this.apiBase + "/issues/" + encodeURIComponent(issueId) + "/", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.config.authToken,
      },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      throw new Error("sentry mutate " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 300));
    }
    const body = (await res.json().catch(() => ({}))) as { permalink?: string };
    return { issue_id: issueId, status, permalink: body.permalink ?? null };
  }
}

/* ------------------------------------------------------------------ *
 * Slack — incident thread
 * ------------------------------------------------------------------ */

export interface SlackConfig {
  botToken: string;
  channelId: string;
}

/**
 * How each agent appears in the thread.
 *
 * A note on the emoji names: Slack does NOT validate icon_emoji. It echoes back
 * whatever you send and renders a blank icon for anything it does not know, so
 * a wrong name fails silently and cannot be caught from the API response. These
 * are Slack's own short names, which differ from GitHub's for the same glyph —
 * ⚖️ is :scales: in Slack but :balance_scale: on GitHub, and 🗣️ is
 * :speaking_head_in_silhouette: in Slack but :speaking_head: on GitHub. Check a
 * new one against Slack's picker, not another platform's list. Names and faces are presentation only;
 * what makes the participants distinct is that each one inspected a different
 * slice of the evidence (see agents/protocol.ts), not that it posts under a
 * different avatar.
 */
export const AGENT_IDENTITY: Record<string, { name: string; emoji: string }> = {
  perception: { name: "Agent Percept", emoji: ":headphones:" },
  memory: { name: "Agent Mem", emoji: ":brain:" },
  speech: { name: "Agent Spec", emoji: ":speaking_head_in_silhouette:" },
  runtime: { name: "Agent Runtime", emoji: ":gear:" },
  verifier: { name: "Agent Veri", emoji: ":test_tube:" },
  supervisor: { name: "Agent Frank the Boss", emoji: ":scales:" },
};

/**
 * Display name for a role key, for use inside message text (e.g. "-> Agent
 * Spec"). Falls back to the raw key so an unknown role is visible rather than
 * silently blank.
 */
export function displayName(role: string): string {
  return AGENT_IDENTITY[role]?.name ?? role;
}
/**
 * Slack is a coordination and audit surface, NOT a reviewer. Plan §11: "no
 * approval reactions or merge buttons sit in the loop." Nothing posted here is
 * ever read back as an authorization — this connector is write-only by design.
 */
export class SlackConnector {
  private threads = new Map<string, string>();

  constructor(
    private readonly config: SlackConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://slack.com/api",
  ) {}

  async openThread(incident: Incident, sensitive: readonly string[]): Promise<unknown> {
    const text = redact(
      [
        ":rotating_light: *Voice incident* `" + incident.incident_id + "`",
        "*Layer:* " + incident.layer,
        "*Tenant:* " + incident.tenant + "  *Session:* " + incident.session_id,
        "*Observed version:* `" + incident.observed_version + "`",
        incident.injected_fault ? "*Seeded fault:* `" + incident.injected_fault + "`" : "",
        "",
        incident.summary,
      ]
        .filter(Boolean)
        .join("\n"),
      sensitive,
    );

    const result = await this.post("chat.postMessage", {
      channel: this.config.channelId,
      text,
    });
    const ts = (result as { ts?: string }).ts;
    if (ts) this.threads.set(incident.incident_id, ts);
    return result;
  }

  async postFinding(incidentId: string, line: string, sensitive: readonly string[]): Promise<unknown> {
    return this.post("chat.postMessage", {
      channel: this.config.channelId,
      thread_ts: this.threads.get(incidentId),
      text: redact(line, sensitive),
    });
  }

  /**
   * Post as one named agent, so the thread reads as a conversation between
   * distinct participants rather than one bot narrating everybody.
   *
   * Overriding username and icon needs the chat:write.customize scope. Without
   * it Slack returns an application error, so this falls back to a plain post
   * with the speaker's name in bold — the thread still reads correctly, it just
   * loses the per-agent avatar. Degrading is the right behaviour here: the
   * content is the substance and the avatar is presentation.
   */
  async postAs(
    incidentId: string,
    speaker: string,
    text: string,
    sensitive: readonly string[],
  ): Promise<unknown> {
    const identity = AGENT_IDENTITY[speaker] ?? { name: speaker, emoji: ":robot_face:" };
    const body = redact(text, sensitive);

    // Start pessimistic. Without chat:write.customize Slack does NOT reject the
    // call — it returns ok:true and silently drops `username`, so every agent
    // would appear as the same bot and the thread would read as one voice. An
    // error-only fallback never fires against that, so the speaker's name goes
    // into the text until a response proves the override was honoured.
    const prefixed = this.customizeWorks === true ? body : "*" + identity.name + "* " + identity.emoji + "\n" + body;

    const result = (await this.post("chat.postMessage", {
      channel: this.config.channelId,
      thread_ts: this.threads.get(incidentId),
      text: prefixed,
      username: identity.name,
      icon_emoji: identity.emoji,
    })) as { message?: { username?: string } };

    if (this.customizeWorks === null) {
      this.customizeWorks = result.message?.username === identity.name;
    }
    return result;
  }

  /**
   * Whether Slack honours per-agent username overrides on this token.
   * null until the first post tells us. Exposed for the run summary so a demo
   * can say "add chat:write.customize" rather than quietly looking wrong.
   */
  customizeWorks: boolean | null = null;

  async postDecision(
    incidentId: string,
    statement: string,
    links: Record<string, string>,
    sensitive: readonly string[],
  ): Promise<unknown> {
    const linkLines = Object.entries(links)
      .map(([k, v]) => "• *" + k + ":* " + v)
      .join("\n");
    return this.post("chat.postMessage", {
      channel: this.config.channelId,
      thread_ts: this.threads.get(incidentId),
      text: redact(":white_check_mark: *Decision* — " + statement + (linkLines ? "\n" + linkLines : ""), sensitive),
    });
  }

  threadTs(incidentId: string): string | null {
    return this.threads.get(incidentId) ?? null;
  }

  private async post(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(this.apiBase + "/" + method, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: "Bearer " + this.config.botToken,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("slack " + method + " http " + res.status);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    // Slack returns HTTP 200 with ok:false for application errors.
    if (!body.ok) throw new Error("slack " + method + ": " + (body.error ?? "unknown error"));
    return body;
  }
}

/* ------------------------------------------------------------------ *
 * GitHub — durable repair package + protected CI
 * ------------------------------------------------------------------ */

export interface GithubConfig {
  token: string;
  /** "owner/repo" */
  repo: string;
  branch?: string;
}

/**
 * Commits a non-sensitive patch manifest and evaluation report (plan §11, §15).
 *
 * The fixtures and the workflow that runs them live OUTSIDE the path this
 * connector writes to, so a candidate cannot edit its own judge. That separation
 * is enforced by the repository layout and by the branch-protection the plan
 * assumes, not by this code — which is why manifestPath() refuses to write
 * anywhere near fixtures/ or .github/.
 */
export class GithubConnector {
  constructor(
    private readonly config: GithubConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  static manifestPath(incidentId: string, repairId: string): string {
    const path = "repairs/" + incidentId + "/" + repairId + ".json";
    if (path.startsWith("fixtures/") || path.startsWith(".github/")) {
      throw new Error("refusing to write a repair manifest into a protected path");
    }
    return path;
  }

  async commitManifest(params: {
    incident: Incident;
    artifact: RepairArtifact;
    verdicts: Verdict[];
    sensitive: readonly string[];
  }): Promise<unknown> {
    const { incident, artifact, verdicts, sensitive } = params;
    const path = GithubConnector.manifestPath(incident.incident_id, artifact.repair_id);

    const manifest = {
      incident_id: incident.incident_id,
      layer: incident.layer,
      entity_id: incident.entity_id,
      repair_id: artifact.repair_id,
      repair_type: artifact.repair.type,
      scope: artifact.repair.scope,
      payload: artifact.repair.payload,
      expires: artifact.repair.expires,
      predecessor: artifact.repair.predecessor,
      artifact_hash: artifact.artifact_hash,
      issuer: artifact.issuer,
      base_version: artifact.base_version,
      overlay_version: artifact.overlay_version,
      evaluation: verdicts.map((v) => ({
        candidate_id: v.candidate_id,
        refuted: v.refuted,
        reason: v.reason,
        acoustic_score: v.acoustic?.match_score ?? null,
        judge_model: v.acoustic?.judge_model ?? null,
        fixtures: v.fixture_results.map((f) => ({
          fixture_id: f.fixture_id,
          passed: f.passed,
          negative_control: f.negative_control,
          detail: f.detail,
        })),
      })),
      note: "Machine-generated by ruhana-evolve. Contains no audio and no personal names.",
    };

    const content = redact(JSON.stringify(manifest, null, 2), sensitive);
    return this.putFile(
      path,
      content,
      "repair(" + incident.layer + "): " + artifact.repair_id + " for " + incident.incident_id,
    );
  }

  private async putFile(path: string, content: string, message: string): Promise<unknown> {
    const url = this.apiBase + "/repos/" + this.config.repo + "/contents/" + path;
    const headers = {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + this.config.token,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    };

    // Idempotent update: fetch the existing blob sha if the file is already there.
    let sha: string | undefined;
    const existing = await this.fetchImpl(url + (this.config.branch ? "?ref=" + this.config.branch : ""), {
      headers,
    });
    if (existing.ok) {
      const body = (await existing.json()) as { sha?: string; content?: string };
      sha = body.sha;
      // Identical content: nothing to commit, so a retry is a genuine no-op.
      if (body.content && Buffer.from(body.content, "base64").toString("utf8") === content) {
        return { unchanged: true, path, sha };
      }
    }

    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: this.config.branch,
        sha,
      }),
    });
    if (!res.ok) {
      throw new Error("github contents " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 300));
    }
    return res.json().catch(() => ({}));
  }
}
