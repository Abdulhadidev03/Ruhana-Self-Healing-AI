// Session configuration for Anam audio passthrough, matching the documented
// SDK (anam.ai/docs/javascript-sdk/examples/custom-tts, verified 2026-09-14):
//
//   server:  personaConfig: { avatarId, avatarModel, enableAudioPassthrough: true }
//   client:  createClient(sessionToken, { disableInputAudio: true })
//   stream:  anamClient.createAgentAudioInputStream(ANAM_AUDIO_INPUT_FORMAT)
//            .sendAudioChunk(...) / .endSequence()
//
// Passthrough is configured AT SESSION CREATION (plan §8) — a live built-in
// session cannot switch modes. The input stream must be created after
// streamToVideoElement() resolves.

export interface PassthroughSessionOptions {
  avatarId: string;
  /** Anam avatar model; the custom-TTS example uses "cara-4". */
  avatarModel?: string;
  name?: string;
}

/** Documented requirement: PCM 16-bit, 16000 Hz, mono. Kokoro renders at
 *  24000 Hz — resample with resamplePcm16 before sending (audio/pcm.ts). */
export const ANAM_AUDIO_INPUT_FORMAT = {
  encoding: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
} as const;

export interface PassthroughSessionConfig {
  personaConfig: {
    avatarId: string;
    avatarModel: string;
    enableAudioPassthrough: true;
    name?: string;
  };
}

export function buildPassthroughSessionConfig(
  opts: PassthroughSessionOptions,
): PassthroughSessionConfig {
  if (!opts.avatarId) throw new Error("avatarId is required");
  return {
    personaConfig: {
      avatarId: opts.avatarId,
      avatarModel: opts.avatarModel ?? "cara-4",
      enableAudioPassthrough: true,
      ...(opts.name ? { name: opts.name } : {}),
    },
  };
}

/** Client-side options for createClient: our mic path is separate (plan §3). */
export const ANAM_CLIENT_OPTIONS = { disableInputAudio: true } as const;
