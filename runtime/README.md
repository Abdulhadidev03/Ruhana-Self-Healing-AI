# Part A — voice runtime

Runtime half of Ruhana Evolve (see `../WORK-SPLIT.md`). Everything here is
plain TypeScript with seams for the pieces that need live accounts, so the
core logic is fully unit-tested without audio hardware.

## Modules

| File | Responsibility |
|---|---|
| `src/overlay.ts` | Versioned session repair overlay: stage anytime, activate only at turn boundaries; tenant/entity/session scope enforcement. |
| `src/speech-input.ts` | Display text → speech segments; scoped phoneme substitution, whole-word only. |
| `src/turn-controller.ts` | Orchestrates a turn: snapshot version → brain → speech input → TTS → deliver; turn epochs cancel superseded utterances. |
| `src/failure-injector.ts` | Labelled seeded fault for the demo (drops the pronunciation override). |
| `src/evidence.ts` | Per-utterance evidence assembly + retried async POST to the Evidence API. |
| `src/repairs-client.ts` | Polls the Repair API and stages overlays. |
| `src/audio/pcm.ts` | Float32→PCM16, framing, duration — for Anam audio passthrough. |
| `src/anam/session-config.ts` | Passthrough session config (set at creation; mono `pcm_s16le`). |
| `src/tts/engine.ts` | `TTSEngine` seam: `KokoroHttpEngine` (local worker) + deterministic mock. |
| `src/stt/transcriber.ts` | `Transcriber` seam: Groq Whisper + scripted mock. |

## Commands

```bash
npm test          # vitest suite (30 tests)
npm run typecheck # tsc --noEmit
npm run mock:evolve  # HTTP mock of Part B's endpoints on :4820
```

## Still to wire (needs live accounts / hardware)

- Kokoro worker process (HTTP `/synthesize` accepting speech segments; returns PCM16 + `x-synthesis-meta`).
- Real Anam session creation + agent audio input stream in the widget.
- Mic capture + VAD in the browser, audio upload to private object storage (evidence URLs).
- The thin adapter inside the Ruhana product repo calling into these modules.
