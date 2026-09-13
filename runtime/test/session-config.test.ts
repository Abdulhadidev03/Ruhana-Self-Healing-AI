import { describe, expect, it } from "vitest";
import {
  ANAM_AUDIO_INPUT_FORMAT,
  buildPassthroughSessionConfig,
} from "../src/anam/session-config.ts";
import { resamplePcm16 } from "../src/audio/pcm.ts";

describe("buildPassthroughSessionConfig", () => {
  it("matches the documented custom-TTS session shape", () => {
    const config = buildPassthroughSessionConfig({ avatarId: "avatar-1" });
    expect(config).toEqual({
      personaConfig: {
        avatarId: "avatar-1",
        avatarModel: "cara-4",
        enableAudioPassthrough: true,
      },
    });
  });

  it("requires an avatarId", () => {
    expect(() => buildPassthroughSessionConfig({ avatarId: "" })).toThrow();
  });

  it("input stream format is the documented 16 kHz mono pcm_s16le", () => {
    expect(ANAM_AUDIO_INPUT_FORMAT).toEqual({
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    });
  });
});

describe("resamplePcm16 (Kokoro 24 kHz -> Anam 16 kHz)", () => {
  it("produces 2/3 of the samples for 24k->16k", () => {
    const src = new Int16Array(2400).fill(1000);
    const out = resamplePcm16(src, 24000, 16000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBe(1000);
    expect(out[out.length - 1]).toBe(1000);
  });

  it("is identity for equal rates and interpolates linearly", () => {
    const src = new Int16Array([0, 300, 600]);
    expect(resamplePcm16(src, 16000, 16000)).toBe(src);
    const up = resamplePcm16(src, 16000, 32000);
    expect(up.length).toBe(6);
    expect(up[0]).toBe(0);
    expect(up[up.length - 1]).toBe(600);
  });
});
