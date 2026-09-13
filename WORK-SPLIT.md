# Ruhana Evolve — two-person work split

The project divides along its natural seam: everything that touches **live audio and the avatar** (Part A) versus everything that **diagnoses, repairs, and records** (Part B). The two halves meet only at two JSON APIs, defined below, so both people can build in parallel against mocks and integrate late.

Directory ownership (avoids merge conflicts):

```
contracts/   shared — JSON schemas + fixture files (edit together, small)
runtime/     Part A only
evolve/      Part B only
fixtures/    Part B creates; protected — repair agents never get write access
.github/     Part B (Actions workflows)
```

---

## Part A — Voice runtime & evidence capture

Owns the conversation path: the avatar must speak audio *we* synthesized, and every stage must be recorded as evidence.

1. **Anam audio passthrough session** — session creation with passthrough enabled; supply mono PCM at the declared sample rate through the agent audio input stream (plan §8).
2. **Own TTS** — Kokoro running locally with phoneme-level control; measure one render cycle early (plan §9). Wrap it behind `runtime/tts.ts` so a managed provider (Cartesia) can substitute.
3. **Mic capture + STT** — separate mic track (never mixed with generated speech), Groq Whisper transcription, voice-activity detection.
4. **Evidence taps** — every turn posts to the Evidence API (contract 1): mic segment, transcripts, entity state, intended text, generated PCM, delivery events, all keyed by turn/utterance IDs and the effective repair version.
5. **Repair overlay application** — at each turn boundary, fetch/receive the active session repair version (contract 2) and apply it: pronunciation rule into TTS, entity rebinding into brain context. Cancel pending replies built from superseded state.
6. **Failure injector** — the labelled, seeded pronunciation fault in the demo baseline (plan §12).
7. **Demo UI (front half)** — the four aligned rows: heard audio, recognized words, intended words, spoken audio.

Deliverable checkpoint: avatar speaks our synthesized audio; a reproducible seeded mispronunciation with all evidence retained.

## Part B — Evolve service, agents & app integrations

Owns everything from evidence-in to verified-repair-out, plus the three external apps.

1. **Evidence store + incident detection** — Supabase schema for the evidence contract, audio object storage, discrepancy detection that opens an incident.
2. **Specialist agents** — perception, memory, speech (runtime specialist deferred), each inspecting its own evidence first; bounded typed messages (plan §4).
3. **Supervisor + adversarial verifier** — GPT-OSS-120B supervisor commissions ≤2 candidate experiments; Gemini audio model as independent acoustic judge; verifier attacks candidates with protected fixtures.
4. **Machine release gate + versioning** — the six deterministic gate conditions (plan §10); immutable repair artifacts; session overlay versioning; automatic rollback.
5. **External apps** — Sentry issue lifecycle (open → resolve → reopen on rollback), Slack incident threads (findings + decision), GitHub patch-manifest commits with an Actions run executing the protected fixtures. All async and idempotent by incident/version key.
6. **Evaluation suite** — the fixed pre-decided fixture set and the results table (plan §14).
7. **Demo UI (back half)** — diagnosed layer, candidate results, active version, app record links.

Deliverable checkpoint: given a mocked incident payload, the full loop runs — diagnosis, two candidates, verifier rejection of the bad one, gate release, three real app records.

---

## The two contracts (agree on these first, ~30 minutes together)

**1. Evidence API** — `POST /api/evidence/turn` (runtime → Evolve):

```json
{
  "tenant": "demo", "session_id": "s-42", "turn_id": "t-7",
  "effective_version": "base+overlay.3",
  "mic_audio_url": "...", "primary_transcript": {"text": "...", "model": "..."},
  "entities": [{"entity_id": "demo-person-17", "surface": "Ayesha"}],
  "intended_text": "...", "generated_audio_url": "...",
  "delivery_events": [{"type": "playback_start", "client_ts": 0}]
}
```

**2. Repair API** — `GET /api/session/{id}/repairs` (runtime ← Evolve), and a push/poll for mid-session updates:

```json
{
  "session_id": "s-42", "overlay_version": 3,
  "repairs": [{
    "repair_id": "r-9", "type": "pronunciation",
    "scope": {"entity_id": "demo-person-17"},
    "payload": {"phonemes": "..."},
    "expires": "session_end", "predecessor": "r-8"
  }]
}
```

Both sides commit mock implementations of the *other* side's API into `contracts/mocks/` on day one, so neither is ever blocked.

## Integration milestones

1. **M1 — contracts frozen**: schemas committed, both mocks passing a shared round-trip test.
2. **M2 — half-loop each**: A demos seeded failure with real evidence posted; B demos full repair loop from a canned evidence file.
3. **M3 — wire-up**: swap mocks for real endpoints; the plan §12 demo runs end to end.
4. **M4 — polish**: dashboard, negative control, rollback proof, record the 2-minute video.

Suggested assignment: whoever has the Anam account access and knows the existing `agaentic_bot` widget/session code takes Part A (it also owns the thin adapter inside the product repo); the other takes Part B. Part B is the larger share of new code but has zero dependency on Anam/audio hardware, so it parallelizes cleanly.
