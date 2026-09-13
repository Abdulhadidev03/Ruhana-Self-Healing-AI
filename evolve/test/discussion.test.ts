// The challenge round (plan §4 step 2) and per-agent Slack identity.

import { describe, expect, it } from "vitest";
import { dissent, runChallengeRound, type ChallengeMessage } from "../src/agents/discussion.ts";
import { ScriptedLLM } from "../src/providers/llm.ts";
import { SlackConnector, AGENT_IDENTITY } from "../src/apps/connectors.ts";
import type { Finding, Incident } from "../src/domain/model.ts";
import { recordingFetch } from "./helpers.ts";

const INCIDENT: Incident = {
  incident_id: "inc-1",
  tenant: "demo",
  session_id: "s-42",
  turn_id: "t-1",
  utterance_id: "t-1-u1",
  layer: "pronunciation",
  entity_id: "demo-person-17",
  observed_version: "base-1+overlay.0",
  evidence_ids: ["ev-1"],
  summary: "mispronounced",
  status: "open",
  opened_at: 1,
  released_repair_id: null,
  injected_fault: null,
};

function finding(specialist: Finding["specialist"], layer: Finding["layer"]): Finding {
  return {
    specialist,
    hypothesis: specialist + " says something",
    layer,
    evidence_refs: ["ev-1"],
    disconfirming_condition: "something would disprove it",
    confidence: 0.6,
    proposed_experiment: null,
  };
}

function llmReturning(body: (task: string, system: string) => string): ScriptedLLM {
  return new ScriptedLLM({
    "discussion.challenge": (req) => body(req.task, req.system),
  });
}

describe("challenge round", () => {
  it("gives every specialist a turn", async () => {
    const llm = llmReturning(() =>
      JSON.stringify({ to: "all", stance: "agree", text: "I concur.", references: ["ev-1"] }),
    );

    const messages = await runChallengeRound(llm, INCIDENT, [
      finding("perception", "undetermined"),
      finding("memory", "undetermined"),
      finding("speech", "pronunciation"),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.from).sort()).toEqual(["memory", "perception", "speech"]);
  });

  it("shows each specialist only the OTHERS' findings, never its own twice", async () => {
    const seen: string[] = [];
    const llm = new ScriptedLLM({
      "discussion.challenge": (req) => {
        seen.push(req.user);
        return JSON.stringify({ to: "all", stance: "agree", text: "ok", references: [] });
      },
    });

    await runChallengeRound(llm, INCIDENT, [
      finding("perception", "undetermined"),
      finding("speech", "pronunciation"),
    ]);

    for (const payload of seen) {
      const parsed = JSON.parse(payload) as {
        your_own_finding: { hypothesis: string };
        what_the_others_concluded: { specialist: string }[];
      };
      const own = parsed.your_own_finding.hypothesis;
      expect(parsed.what_the_others_concluded.map((o) => o.specialist)).not.toContain(
        own.split(" ")[0],
      );
      expect(parsed.what_the_others_concluded).toHaveLength(1);
    }
  });

  it("drops citations to evidence the specialist never inspected", async () => {
    // Anti-fabrication: a model that invents an evidence id must not be able to
    // launder it into the audit record.
    const llm = llmReturning(() =>
      JSON.stringify({
        to: "all",
        stance: "challenge",
        text: "Look at the other clip.",
        references: ["ev-1", "ev-INVENTED", "ev-also-fake"],
      }),
    );

    const messages = await runChallengeRound(llm, INCIDENT, [
      finding("perception", "undetermined"),
      finding("speech", "pronunciation"),
    ]);

    for (const m of messages) {
      expect(m.references).toEqual(["ev-1"]);
    }
  });

  it("a specialist that returns unusable output simply does not speak", async () => {
    const llm = new ScriptedLLM({
      "discussion.challenge": (req) =>
        /perception/.test(req.system) ? "not json at all" : JSON.stringify({ stance: "agree", text: "fine" }),
    });

    const messages = await runChallengeRound(llm, INCIDENT, [
      finding("perception", "undetermined"),
      finding("speech", "pronunciation"),
    ]);

    // Two specialists, one unusable reply -> one message. Never a fabricated turn.
    expect(messages).toHaveLength(1);
    expect(messages[0]!.from).toBe("speech");
  });

  it("an empty reply is not posted as an empty message", async () => {
    const llm = llmReturning(() => JSON.stringify({ stance: "agree", text: "   " }));
    const messages = await runChallengeRound(llm, INCIDENT, [
      finding("perception", "undetermined"),
      finding("speech", "pronunciation"),
    ]);
    expect(messages).toHaveLength(0);
  });

  it("does not run with fewer than two participants", async () => {
    const llm = llmReturning(() => JSON.stringify({ stance: "agree", text: "hello" }));
    expect(await runChallengeRound(llm, INCIDENT, [finding("speech", "pronunciation")])).toEqual([]);
  });

  it("falls back to 'defer' rather than inventing a stance", async () => {
    const llm = llmReturning(() =>
      JSON.stringify({ stance: "strongly-agree-with-caveats", text: "hmm" }),
    );
    const messages = await runChallengeRound(llm, INCIDENT, [
      finding("perception", "undetermined"),
      finding("speech", "pronunciation"),
    ]);
    expect(messages.every((m) => m.stance === "defer")).toBe(true);
  });

  it("dissent() surfaces only genuine pushback", async () => {
    const messages: ChallengeMessage[] = [
      { from: "speech", to: "all", text: "a", stance: "agree", references: [] },
      { from: "memory", to: "all", text: "b", stance: "challenge", references: [] },
      { from: "perception", to: "all", text: "c", stance: "refine", references: [] },
      { from: "runtime", to: "all", text: "d", stance: "defer", references: [] },
    ];
    expect(dissent(messages).map((m) => m.from)).toEqual(["memory", "perception"]);
  });
});

describe("per-agent Slack identity", () => {
  function connector(rec: ReturnType<typeof recordingFetch>) {
    return new SlackConnector({ botToken: "xoxb-test", channelId: "C1" }, rec.fetch);
  }

  it("asks Slack to post under the agent's own name and icon", async () => {
    const rec = recordingFetch();
    await connector(rec).postAs("inc-1", "speech", "the audio diverges", []);

    const body = rec.requests[0]!.body as { username?: string; icon_emoji?: string };
    expect(body.username).toBe(AGENT_IDENTITY["speech"]!.name);
    expect(body.icon_emoji).toBe(AGENT_IDENTITY["speech"]!.emoji);
  });

  it("keeps the speaker's name in the text until Slack proves it honoured the override", async () => {
    // Without chat:write.customize Slack returns ok:true and silently ignores
    // `username`. An error-only fallback never fires, and every agent would
    // appear as the same bot. So the name stays in the text until proven safe.
    const rec = recordingFetch();
    const slack = connector(rec);

    await slack.postAs("inc-1", "verifier", "could not refute it", []);

    expect(slack.customizeWorks).toBe(false);
    const text = (rec.requests[0]!.body as { text: string }).text;
    expect(text).toContain("*" + AGENT_IDENTITY["verifier"]!.name + "*");
    expect(text).toContain("could not refute it");
  });

  it("redacts personal names in agent speech too", async () => {
    const rec = recordingFetch();
    await connector(rec).postAs("inc-1", "speech", "Ayesha was mispronounced", ["Ayesha"]);
    const text = (rec.requests[0]!.body as { text: string }).text;
    expect(text).not.toContain("Ayesha");
  });
});
