// PCM utilities for Anam audio passthrough (plan §8: supply correctly encoded
// mono PCM at the actual declared sample rate).

/** Float32 samples in [-1, 1] → little-endian PCM16, with clamping. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return out;
}

/** Split PCM into frames of frameMs; the final frame is zero-padded to size. */
export function chunkPcm(pcm: Int16Array, sampleRate: number, frameMs: number): Int16Array[] {
  if (sampleRate <= 0 || frameMs <= 0) throw new Error("sampleRate and frameMs must be positive");
  const frameSize = Math.round((sampleRate * frameMs) / 1000);
  const frames: Int16Array[] = [];
  for (let off = 0; off < pcm.length; off += frameSize) {
    const frame = new Int16Array(frameSize);
    frame.set(pcm.subarray(off, Math.min(off + frameSize, pcm.length)));
    frames.push(frame);
  }
  return frames;
}

/** Duration in ms of a PCM buffer at a sample rate (mono). */
export function pcmDurationMs(pcm: Int16Array, sampleRate: number): number {
  return (pcm.length / sampleRate) * 1000;
}
