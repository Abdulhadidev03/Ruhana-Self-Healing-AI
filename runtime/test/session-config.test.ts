import { describe, expect, it } from "vitest";
import { buildPassthroughSessionConfig } from "../src/anam/session-config.ts";

describe("buildPassthroughSessionConfig", () => {
  it("builds a passthrough config with mono pcm_s16le at the declared rate", () => {
    const config = buildPassthroughSessionConfig({
      personaName: "Ruhana Demo",
      avatarId: "avatar-1",
      sampleRate: 24000,
    });
    expect(config.audioPassthrough).toEqual({
      enabled: true,
      encoding: "pcm_s16le",
      channels: 1,
      sampleRate: 24000,
    });
    expect(config.personaConfig.llmId).toBe("CUSTOMER_CLIENT_V1");
  });

  it("rejects invalid sample rates", () => {
    expect(() =>
      buildPassthroughSessionConfig({ personaName: "x", avatarId: "a", sampleRate: -1 }),
    ).toThrow();
    expect(() =>
      buildPassthroughSessionConfig({ personaName: "x", avatarId: "a", sampleRate: 22050.5 }),
    ).toThrow();
  });
});
