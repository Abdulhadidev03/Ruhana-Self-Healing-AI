import { describe, expect, it } from "vitest";
import { chunkPcm, floatToPcm16, pcmDurationMs } from "../src/audio/pcm.ts";

describe("floatToPcm16", () => {
  it("converts and clamps", () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0x7fff);
    expect(out[2]).toBe(-0x8000);
    expect(out[3]).toBe(0x7fff);
    expect(out[4]).toBe(-0x8000);
    expect(out[5]).toBe(Math.round(0.5 * 0x7fff));
  });
});

describe("chunkPcm", () => {
  it("splits into equal frames, zero-padding the last", () => {
    const sampleRate = 1000; // 1 sample per ms for easy math
    const pcm = new Int16Array(250).fill(7);
    const frames = chunkPcm(pcm, sampleRate, 100);
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.length === 100)).toBe(true);
    expect(frames[2]![49]).toBe(7);
    expect(frames[2]![50]).toBe(0); // padding
  });

  it("rejects non-positive parameters", () => {
    expect(() => chunkPcm(new Int16Array(10), 0, 100)).toThrow();
    expect(() => chunkPcm(new Int16Array(10), 24000, 0)).toThrow();
  });
});

describe("pcmDurationMs", () => {
  it("computes duration from sample count", () => {
    expect(pcmDurationMs(new Int16Array(24000), 24000)).toBe(1000);
    expect(pcmDurationMs(new Int16Array(12000), 24000)).toBe(500);
  });
});
