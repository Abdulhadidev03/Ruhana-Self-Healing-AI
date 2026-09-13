// Session configuration for Anam audio passthrough mode (plan §8): passthrough
// is configured AT SESSION CREATION — do not assume a live built-in session can
// switch modes. In this mode the app supplies its own STT, brain, and TTS, and
// pushes PCM through the agent audio input stream.

export interface PassthroughSessionOptions {
  personaName: string;
  avatarId: string;
  sampleRate: number;
}

export interface PassthroughSessionConfig {
  personaConfig: {
    name: string;
    avatarId: string;
    // Custom-client mode: Anam's built-in LLM/TTS path is bypassed.
    llmId: "CUSTOMER_CLIENT_V1";
  };
  audioPassthrough: {
    enabled: true;
    encoding: "pcm_s16le";
    channels: 1;
    sampleRate: number;
  };
}

export function buildPassthroughSessionConfig(
  opts: PassthroughSessionOptions,
): PassthroughSessionConfig {
  if (!Number.isInteger(opts.sampleRate) || opts.sampleRate <= 0) {
    throw new Error(`invalid sampleRate: ${opts.sampleRate}`);
  }
  return {
    personaConfig: {
      name: opts.personaName,
      avatarId: opts.avatarId,
      llmId: "CUSTOMER_CLIENT_V1",
    },
    audioPassthrough: {
      enabled: true,
      encoding: "pcm_s16le",
      channels: 1,
      sampleRate: opts.sampleRate,
    },
  };
}
