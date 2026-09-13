# Evolve service (Part B)

Evidence in, verified repair out. Owns everything from a posted evidence turn to
an activated, recorded, revocable repair.

```bash
npm test                  # 30 Part A tests + 51 Part B tests
npm run evolve:demo       # the plan §12 story, narrated, no network
npm run evolve:demo -- --live
npm run evolve:eval       # the plan §14 results table
npm run evolve:serve      # the two contract endpoints + dashboard
```

Wiring the runtime to it: see [INTEGRATION.md](../INTEGRATION.md).

## The loop

```
POST /api/evidence/turn
        │
        ├─ store evidence            idempotent on tenant:session:turn:utterance
        ├─ observe()                 does this turn confirm or refute an ACTIVE repair?
        │                            └─ regressed -> roll back, quarantine, reopen Sentry
        └─ detect()                  structural discrepancy -> open incident
                 │                   (suspects a layer; does not diagnose)
                 ▼
        runRepairLoop()
                 │
                 ├─ specialists       perception / memory / speech, in parallel,
                 │                    each seeing ONLY its own evidence slice
                 ├─ commission        ≤ 2 candidate experiments
                 ├─ render            out-of-band; the caller never hears a candidate
                 ├─ verify            adversarial: 6 protected fixtures + acoustic judge
                 ├─ supervise         structured decision, with code guardrails
                 ├─ GATE              6 deterministic conditions — the control boundary
                 ├─ issue artifact    hashed, immutable
                 ├─ overlay += 1      now served on GET /api/session/{id}/repairs
                 └─ enqueue records   Sentry / Slack / GitHub, async and idempotent
```

## Layout

| Path | What lives there |
|---|---|
| `domain/` | Pure logic, no I/O: detection, the gate, artifacts, overlay versioning, the registry. |
| `agents/` | The specialists, the adversarial verifier, the supervisor, and the evidence-slicing protocol. |
| `providers/` | Every external dependency behind an interface, each with a real implementation and a deterministic fake. |
| `apps/` | Sentry, Slack, GitHub, and the idempotent async write queue. |
| `api/` | The HTTP service. |
| `eval/` | The plan §14 scenario suite and results table. |
| `../fixtures/protected/` | The protected fixture set. No agent has write access. |

## Design decisions that are load-bearing

**The gate is model-free.** `domain/gate.ts` never reads a confidence number.
Plan §10: "A self-reported confidence number is not enough." The supervisor is
model-backed and therefore untrusted — if it tries to release a refuted
candidate, code rewrites the decision to a rejection and records the attempt.

**Specialists get narrow views, enforced by types.** `agents/protocol.ts` builds
a different slice of the evidence per role. Perception cannot see the intended
text; speech cannot see the microphone track. Six prompts over the same
transcript would not be six independent sources of knowledge.

**The verifier tests through Part A's real code.** It calls
`runtime/src/speech-input.ts`, not a reimplementation. A candidate that would not
apply in the actual runtime fails verification rather than surfacing at wire-up.

**Reference data is immutable to agents.** `domain/registry.ts` splits
`ReferenceRegistry` (read-only) from `MutableRegistry`. A candidate cannot
redefine the correct answer to make itself pass; gate condition 4 rejects any
payload that tries.

**Absent evidence is an abstention, not a pass.** No reference recording means no
pronunciation repair is proposed. A failed independent decode means perception
reports that it could not check, rather than staying silent.

**Ids are derived from content.** The same failure produces the same
`incident_id`, so a retried Sentry or Slack write updates one record instead of
creating a second.

## What the test suite does and does not prove

The 51 Part B tests and the 12-scenario eval run against deterministic providers.
They establish that the **orchestration** is correct: detection fires, evidence
scoping holds, two candidates are measured, the harmful one is refuted, all six
gate conditions behave independently, rollback advances the overlay, app writes
are idempotent, and a downed connector cannot block a verified repair.

They do **not** establish that real audio was judged. `PhonemeMatchJudge`
compares phoneme strings; it performs no acoustic analysis, and says so in its
own `notes`. That claim needs a live Kokoro renderer plus `OpenAIAudioJudge` or
`GeminiAudioJudge`. The eval report prints a provenance table so a deterministic
run is never presented as a live one.

Live model runs have been verified separately: `gpt-5.6-terra` as the specialist
proposing candidates and `gpt-5.6-luna` supervising, over the OpenAI Responses
API. Three consecutive live runs released the correct repair and refuted the
alternative.

## Known gaps

- **Store is in-memory.** `providers/store.ts` defines the interface; a Supabase
  implementation slots in behind it. Plan §15 requires a separate Evolve
  database, not the product's.
- **`artifact_hash` is not on the wire.** Held internally; see INTEGRATION.md.
- **The runtime specialist is deferred**, as the plan scopes it.
- **Tenant-wide promotion is not implemented.** Repairs are session-scoped only,
  which is the conservative half of plan §7.
