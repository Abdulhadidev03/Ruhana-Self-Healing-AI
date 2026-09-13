// The repair supervisor (plan §4).
//
// Permitted outputs: "Choose a candidate, request one more experiment, reject,
// release within scope, or revert."
//
// The supervisor is model-backed, and therefore not trusted. Two guardrails are
// enforced in code around whatever it returns:
//
//   * It cannot choose a candidate the verifier refuted. If the model tries, the
//     decision is rewritten to a rejection and the attempt is recorded.
//   * It cannot widen scope beyond the incident's entity.
//
// These duplicate gate conditions 1 and 3 on purpose. The gate is the control
// boundary, but a supervisor that quietly tries to release refuted work is
// something the incident record should show rather than something the gate
// silently absorbs.

import type { LLM } from "../providers/llm.ts";
import { parseJsonReply } from "../providers/llm.ts";
import type {
  Candidate,
  Finding,
  Incident,
  ProposedExperiment,
  SupervisorDecision,
  Verdict,
} from "../domain/model.ts";

export interface SupervisorInput {
  incident: Incident;
  findings: Finding[];
  candidates: Candidate[];
  verdicts: Verdict[];
}

export interface SupervisorOutcome {
  decision: SupervisorDecision;
  /** Set when code overrode what the model asked for. */
  overrode: string | null;
  /** Concise line for the Slack thread and dashboard. */
  statement: string;
}

/** Plan §9: "cap candidate count at two" for a first repair. */
export const MAX_CANDIDATES = 2;

export class Supervisor {
  constructor(private readonly llm: LLM) {}

  /**
   * Step 3 of the protocol: commission at most a small number of experiments.
   * Selection is by specialist confidence and whether a concrete payload exists;
   * a finding with no proposed experiment cannot be commissioned.
   */
  commission(findings: Finding[]): { finding: Finding; experiment: ProposedExperiment }[] {
    const ranked = findings
      .filter((f) => f.proposed_experiment !== null && f.layer !== "undetermined")
      .sort((a, b) => b.confidence - a.confidence);

    const out: { finding: Finding; experiment: ProposedExperiment }[] = [];
    // Primary proposals first, so the strongest specialist is always tested.
    for (const f of ranked) {
      if (out.length >= MAX_CANDIDATES) break;
      out.push({ finding: f, experiment: f.proposed_experiment! });
    }
    // Then alternatives, up to the §9 cap of two total.
    for (const f of ranked) {
      for (const alt of f.alternative_experiments ?? []) {
        if (out.length >= MAX_CANDIDATES) break;
        out.push({ finding: f, experiment: alt });
      }
    }
    return out;
  }

  async decide(input: SupervisorInput): Promise<SupervisorOutcome> {
    const { incident, findings, candidates, verdicts } = input;

    const survivors = candidates.filter((c) => {
      const v = verdicts.find((x) => x.candidate_id === c.candidate_id);
      return v !== undefined && !v.refuted;
    });
    const refutedIds = candidates
      .filter((c) => !survivors.some((s) => s.candidate_id === c.candidate_id))
      .map((c) => c.candidate_id);

    // Nothing survived: this is a rejection, and no model call is needed to
    // establish that. Plan §10: automatic restraint is a success mode.
    if (survivors.length === 0) {
      return {
        decision: {
          action: candidates.length === 0 ? "request_more_evidence" : "reject",
          chosen_candidate_id: null,
          rejected_candidate_ids: refutedIds,
          rationale:
            candidates.length === 0
              ? "No specialist produced a testable experiment on the available evidence."
              : "Every candidate was refuted by the protected fixtures; containing rather than releasing.",
          scope: {
            tenant: incident.tenant,
            entity_id: incident.entity_id,
            session_id: incident.session_id,
          },
        },
        overrode: null,
        statement:
          candidates.length === 0
            ? "No supported repair. Containing: the agent should avoid repeating the uncertain name."
            : "All " + candidates.length + " candidate(s) refuted. No release.",
      };
    }

    const reply = await this.llm.complete({
      task: "supervisor.decide",
      maxTokens: 700,
      system:
        "You are the repair supervisor in an automated voice-repair system. You choose between releasing one verified candidate, rejecting all of them, or containing the failure. You never invent evidence. Reply only with JSON.",
      user: JSON.stringify({
        incident: {
          incident_id: incident.incident_id,
          layer: incident.layer,
          entity_id: incident.entity_id,
          summary: incident.summary,
        },
        specialist_findings: findings.map((f) => ({
          specialist: f.specialist,
          layer: f.layer,
          hypothesis: f.hypothesis,
          disconfirming_condition: f.disconfirming_condition,
        })),
        candidates_that_survived_verification: survivors.map((c) => ({
          candidate_id: c.candidate_id,
          type: c.type,
          rationale: c.rationale,
          payload: c.payload,
        })),
        refuted_candidates: verdicts
          .filter((v) => v.refuted)
          .map((v) => ({ candidate_id: v.candidate_id, reason: v.reason, counterexamples: v.counterexamples })),
        reply_shape: {
          action: "release | reject | contain | request_more_evidence",
          chosen_candidate_id: "string or null",
          rationale: "one or two sentences",
        },
      }),
    });

    let action: SupervisorDecision["action"] = "reject";
    let chosen: string | null = null;
    let rationale = "";
    try {
      const parsed = parseJsonReply<{
        action?: string;
        chosen_candidate_id?: string | null;
        rationale?: string;
      }>(reply.text);
      if (
        parsed.action === "release" ||
        parsed.action === "reject" ||
        parsed.action === "contain" ||
        parsed.action === "request_more_evidence"
      ) {
        action = parsed.action;
      }
      chosen = parsed.chosen_candidate_id ?? null;
      rationale = parsed.rationale ?? "";
    } catch (err) {
      // An unparseable supervisor reply is a rejection, never a release.
      return {
        decision: {
          action: "reject",
          chosen_candidate_id: null,
          rejected_candidate_ids: candidates.map((c) => c.candidate_id),
          rationale: "Supervisor reply could not be parsed: " + String(err),
          scope: { tenant: incident.tenant, entity_id: incident.entity_id, session_id: incident.session_id },
        },
        overrode: "unparseable supervisor reply",
        statement: "Supervisor output was unreadable; defaulting to no release.",
      };
    }

    let overrode: string | null = null;

    // Guardrail 1: the chosen candidate must exist and must have survived.
    if (action === "release") {
      const ok = survivors.some((s) => s.candidate_id === chosen);
      if (!ok) {
        overrode =
          "supervisor selected '" +
          (chosen ?? "null") +
          "' which was refuted or unknown; rewritten to reject";
        action = "reject";
        chosen = null;
      }
    }

    const decision: SupervisorDecision = {
      action,
      chosen_candidate_id: action === "release" ? chosen : null,
      rejected_candidate_ids: refutedIds.concat(
        action === "release" ? survivors.filter((s) => s.candidate_id !== chosen).map((s) => s.candidate_id) : [],
      ),
      rationale: rationale || "(no rationale returned)",
      // Guardrail 2: scope is taken from the incident, never from the model.
      scope: {
        tenant: incident.tenant,
        entity_id: incident.entity_id,
        session_id: incident.session_id,
      },
    };

    const statement =
      decision.action === "release"
        ? "Activate " + decision.chosen_candidate_id + " for the next eligible turn. " + decision.rationale
        : decision.action === "reject"
          ? "Reject all candidates. " + decision.rationale
          : decision.action === "contain"
            ? "Contain: avoid repeating the uncertain name until a supported repair exists."
            : "Request more evidence before proposing a change.";

    return { decision, overrode, statement };
  }
}
