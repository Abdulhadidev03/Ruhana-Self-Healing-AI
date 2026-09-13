# Integration notes — Part A ↔ Part B

Everything Part A needs to point the runtime at the real Evolve service instead
of `contracts/mocks/evolve-mock.ts`. Nothing in `runtime/` or `contracts/types.ts`
was changed to build Part B.

## Running the service

```bash
npm install
npm run evolve:serve        # http://localhost:4830
```

Point the runtime at it:

```ts
const sink   = new HttpEvidenceSink("http://localhost:4830")
const client = new RepairsClient("http://localhost:4830", sessionId, overlayStore)
```

No credentials are required. Without keys the service runs deterministic
stand-ins for the model, judge and renderer; the startup banner and
`GET /api/dashboard` both report which providers are actually live, so a
deterministic run can never be mistaken for a real one.

## The two contract endpoints

Both are wire-identical to `contracts/mocks/evolve-mock.ts`, which is what the
round-trip test asserts.

| Method | Path | Response |
|---|---|---|
| `POST` | `/api/evidence/turn` | `{ accepted: boolean, duplicate: boolean }` |
| `GET` | `/api/session/{id}/repairs` | `RepairOverlay` |

`POST` returns as soon as detection has run. The repair loop starts in the
background and is **not** awaited — plan §5 requires the conversation never to
wait on a multi-agent round trip. Poll contract 2 to pick the repair up.

Malformed evidence returns `400` with `{ accepted: false, error }` rather than
being stored. `HttpEvidenceSink` already treats that as a failure and retries.

Extra endpoints, which the runtime never calls: `GET /api/dashboard`,
`GET /api/incidents`, `GET /health`.

## Three things worth knowing

**1. Rollback moves the overlay version UP, not down.**

`SessionOverlayStore.stage()` only accepts an overlay whose `overlay_version` is
strictly greater than the one it holds. So a rollback cannot be expressed by
reverting to an earlier number — the runtime would silently ignore it. Evolve
emits a *new, higher* version with the repair removed. Version 2 having fewer
repairs than version 1 is a rollback, not a bug.

**2. Detection depends on `speech_input` being populated.**

The pronunciation detector compares the phoneme segment submitted for an entity
against the registry reference. If `speech_input` is absent, a mispronunciation
is invisible to Evolve — there is nothing to compare. Please keep sending the
full `SpeechSegment[]`, including on the failing turn where no override applied
(that plain-text segment *is* the evidence).

`injected_fault` should carry the label (`"seeded-pronunciation-drop"`) so the
incident records that the fault was deliberate. Evolve never infers it.

**3. `Repair` has no `artifact_hash` on the wire.**

Plan §10 wants the runtime to verify a signed artifact before trusting a repair.
`contracts/types.ts` does not carry that field, and I did not want to change a
frozen contract you had already built against. For now Evolve holds the artifact
internally and exposes it at `GET /api/dashboard`.

If you want the runtime-side check, this is the additive change — safe because
it is optional, so existing code keeps compiling:

```ts
export interface Repair {
  // ...existing fields unchanged...
  /** sha256 over the canonical repair body; verify before applying. */
  artifact_hash?: string;
}
```

Say the word and I will populate it. Your call, since it is your file.

## Environment

Copy `.env.example` to `.env`. Everything is optional; each missing key degrades
one capability rather than breaking the service.

| Variable | Effect when absent |
|---|---|
| `OPENAI_API_KEY` | Specialists and supervisor fall back to a scripted stand-in. |
| `EVOLVE_SUPERVISOR_MODEL` | Defaults to `gpt-5.6-luna`. |
| `EVOLVE_SPECIALIST_MODEL` | Defaults to `OPENAI_MODEL`, else `gpt-5.6-terra`. |
| `KOKORO_URL` | Candidates render through a simulated G2P instead of real audio. |
| `SENTRY_*`, `SLACK_*`, `GITHUB_*` | Those app records are simply not written. |

**The renderer is the one that matters for a real demo.** Until `KOKORO_URL`
points at a live worker, the acoustic judge has no real audio to assess, so it
falls back to comparing phoneme strings. That is enough to test the loop and not
enough to claim audio was judged.

### The Kokoro worker contract

If you expose your Kokoro engine over HTTP, Evolve can render candidates
out-of-band (plan §8: inaudible candidate rendering, no second avatar session):

```
POST {KOKORO_URL}/render
  { text, segments: SpeechSegment[], voice_model_version }
->
  { audio_url, rendered_phonemes?, rendered_tokens?, duration_ms? }
```

`rendered_tokens` maps `entity_id` (or bare surface word) → phonemes actually
used. Local Kokoro can report this; most hosted providers cannot. It is optional
but it makes verification much stronger, because the judge can check the target
word rather than the whole utterance.

## One toolchain note

`node --experimental-strip-types` does not support TypeScript **parameter
properties** (`constructor(private readonly x: T) {}`). That affects
`runtime/src/repairs-client.ts` and `runtime/src/evidence.ts` as well as my code
— harmless for you, since Next.js compiles them, but it means neither half runs
under plain `node --experimental-strip-types`. Part B's CLI entry points use
`tsx` (added as a devDependency, alongside vitest and typescript). `npm run
mock:evolve` still works as before.

## Suggested wire-up order (M3)

1. `npm run evolve:serve`, then point `HttpEvidenceSink` and `RepairsClient` at it.
2. Run a session with the injector armed. Confirm the `POST` returns
   `{accepted: true, duplicate: false}` and `GET /api/dashboard` shows an
   incident with `layer: "pronunciation"`.
3. Confirm `RepairsClient` stages an overlay at version 1 and
   `applyAtTurnBoundary()` activates it.
4. Speak a new sentence and confirm the phoneme segment appears in
   `speech_input`. Evolve will then mark the incident `resolved` on its own.
5. Set `KOKORO_URL` and re-run — that is the point at which the acoustic claim
   becomes real.
