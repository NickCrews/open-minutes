import sherpa, { type WaveForm } from "sherpa-onnx-node";

// Returns the slice of `wave.samples` between [startSec, endSec]. Caller-supplied
// bounds are clamped to [0, totalDuration].
export function sliceWave(
  wave: WaveForm,
  startSec: number,
  endSec: number,
): WaveForm {
  if (startSec >= endSec) {
    throw new Error(
      `Invalid slice with startSec >= endSec: ${startSec} >= ${endSec}`,
    );
  }
  const total = wave.samples.length / wave.sampleRate;
  const s = Math.max(0, Math.min(startSec, total));
  const e = Math.max(s, Math.min(endSec, total));
  const startIdx = Math.round(s * wave.sampleRate);
  const endIdx = Math.round(e * wave.sampleRate);
  return {
    sampleRate: wave.sampleRate,
    samples: wave.samples.subarray(startIdx, endIdx),
  };
}

export function readWave(path: string): WaveForm {
  return sherpa.readWave(path);
}
