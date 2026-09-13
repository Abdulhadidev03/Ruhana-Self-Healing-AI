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

/**
 * Linear-interpolation resampler (mono PCM16). Kokoro renders at 24000 Hz;
 * Anam's agent audio input stream requires 16000 Hz.
 */
export function resamplePcm16(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate <= 0 || toRate <= 0) throw new Error("sample rates must be positive");
  if (fromRate === toRate) return pcm;
  const outLength = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const out = new Int16Array(outLength);
  const step = (pcm.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = pos - i0;
    out[i] = Math.round((pcm[i0] ?? 0) * (1 - frac) + (pcm[i1] ?? 0) * frac);
  }
  return out;
}
