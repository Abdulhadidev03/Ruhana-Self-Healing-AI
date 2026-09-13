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
      event_id: incident.incident_id.replace(/-/g, "").padEnd(32, "0").slice(0, 32),
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
    if (!res.ok) throw new Error("sentry store " + res.status);
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

  private async mutate(incidentId: string, status: string, note: string): Promise<unknown> {
    const url =
      this.apiBase +
      "/projects/" +
      encodeURIComponent(this.config.org) +
      "/" +
      encodeURIComponent(this.config.project) +
      "/issues/?query=" +
      encodeURIComponent("incident_id:" + incidentId);

    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.config.authToken,
      },
      body: JSON.stringify({ status, statusDetails: {}, note }),
    });
    if (!res.ok) throw new Error("sentry mutate " + res.status);
    return res.json().catch(() => ({}));
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
    if (!res.ok) throw new Error("github contents " + res.status);
    return res.json().catch(() => ({}));
  }
}
