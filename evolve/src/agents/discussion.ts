// The challenge round (plan §4 step 2, budgeted by §9 as "one challenge round").
//
// Up to this point the specialists have worked in isolation: each saw only its
// own slice of the evidence and none saw another's conclusion. That isolation
// is deliberate and it is what makes three findings three sources rather than
// one prompt repeated three times.
//
// This round is what happens AFTER that. Each specialist now reads the others'
// conclusions and responds in its own words — agreeing, challenging, refining,
// or deferring. The exchange is real: one model call per specialist, with the
// others' actual findings as input. Nothing here is scripted.
//
// Two constraints the plan places on this round, both enforced below:
//
//   * "Agreement is not itself a release criterion" (§1, on the Cost of
//     Consensus result). Nothing this round produces reaches the gate. It
//     informs the supervisor and the audit trail; it cannot release anything.
//   * The UI "should not fabricate private model reasoning" (§4). What is shown
//     is the message the model actually returned, not a narration of reasoning
//     we did not observe.

import type { LLM } from "../providers/llm.ts";
import { parseJsonReply } from "../providers/llm.ts";
import type { Finding, Incident } from "../domain/model.ts";

export type Speaker = Finding["specialist"] | "verifier" | "supervisor";

export type Stance = "agree" | "challenge" | "refine" | "defer";

export interface ChallengeMessage {
  from: Speaker;
  /** Who the message is aimed at, or "all". */
  to: Speaker | "all";
  /** What the agent actually said, in its own words. */
  text: string;
  stance: Stance;
  /** Evidence ids the agent cited. Empty is allowed and is itself informative. */
  references: string[];
}

const STANCES: readonly Stance[] = ["agree", "challenge", "refine", "defer"];

function asStance(value: unknown): Stance {
  return typeof value === "string" && (STANCES as readonly string[]).includes(value)
    ? (value as Stance)
    : "defer";
}

/** One specialist's turn in the round. */
async function speak(
  llm: LLM,
  incident: Incident,
  own: Finding,
  others: Finding[],
): Promise<ChallengeMessage | null> {
  const reply = await llm.complete({
    task: "discussion.challenge",
    maxTokens: 400,
    temperature: 0.4,
    system: [
      "You are the " + own.specialist + " specialist in an automated voice-repair system,",
      "speaking to the other specialists in a shared incident thread.",
      "",
      "Speak plainly, as one engineer to another. One or two sentences. No preamble,",
      "no bullet points, no restating what you already said.",
      "",
      "Rules you must not break:",
      "- Only claim what YOUR evidence supports. You did not see the others' evidence.",
      "- If another specialist's conclusion conflicts with yours, say so and say why.",
      "- If you cannot check something, say that instead of guessing.",
      "- Never invent an evidence id, a score, or a measurement.",
      "",
      "Reply only with JSON.",
    ].join("\n"),
    user: JSON.stringify({
      incident: { layer: incident.layer, summary: incident.summary },
      your_own_finding: {
        layer: own.layer,
        hypothesis: own.hypothesis,
        what_would_disprove_it: own.disconfirming_condition,
        evidence_you_inspected: own.evidence_refs,
      },
      what_the_others_concluded: others.map((f) => ({
        specialist: f.specialist,
        layer: f.layer,
        hypothesis: f.hypothesis,
      })),
      reply_shape: {
        to: "the specialist you are addressing, or 'all'",
        stance: "agree | challenge | refine | defer",
        text: "one or two sentences, conversational",
        references: ["evidence ids you are citing, may be empty"],
      },
    }),
  });

  try {
    const parsed = parseJsonReply<{
      to?: string;
      stance?: string;
      text?: string;
      references?: string[];
    }>(reply.text);

    const text = (parsed.text ?? "").trim();
    if (!text) return null;

    return {
      from: own.specialist,
      to: (parsed.to as Speaker) ?? "all",
      text,
      stance: asStance(parsed.stance),
      // Only evidence this specialist actually inspected can be cited. A model
      // that invents an id must not be able to launder it into the record.
      references: (parsed.references ?? []).filter((r) => own.evidence_refs.includes(r)),
    };
  } catch {
    // A specialist that cannot produce a parseable turn simply does not speak.
    // Dropping its turn is honest; inventing one is not.
    return null;
  }
}

/**
 * Run the single challenge round.
 *
 * Specialists speak concurrently: each sees the findings the others published
 * independently, not each other's live replies. That keeps the round a genuine
 * exchange of positions rather than a chain where later speakers are anchored
 * on earlier ones — which is the failure mode the Cost of Consensus result
 * describes (§1).
 */
export async function runChallengeRound(
  llm: LLM,
  incident: Incident,
  findings: Finding[],
): Promise<ChallengeMessage[]> {
  const speakers = findings.filter((f) => f.hypothesis.trim().length > 0);
  if (speakers.length < 2) return [];

  const turns = await Promise.all(
    speakers.map((own) =>
      speak(
        llm,
        incident,
        own,
        speakers.filter((f) => f.specialist !== own.specialist),
      ).catch(() => null),
    ),
  );

  return turns.filter((t): t is ChallengeMessage => t !== null);
}

/**
 * Did anyone actually push back?
 *
 * Surfaced for the dashboard and the supervisor's context. Deliberately NOT a
 * release input: unanimity is not evidence, and a round where everyone agreed
 * is not a stronger result than one where nobody did.
 */
export function dissent(messages: ChallengeMessage[]): ChallengeMessage[] {
  return messages.filter((m) => m.stance === "challenge" || m.stance === "refine");
}
