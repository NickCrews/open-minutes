// Pitch for voice_timeline: YIN over the 16 kHz samples. A person's pitch
// stays in their own range through a meeting, so a jump in it is a cue the
// speaker changed (a strong one between a low voice and a high one, a weak
// one between two alike).

const PITCH_MIN_HZ = 60;
const PITCH_MAX_HZ = 400;
const PITCH_FRAME_SEC = 0.04;
/** YIN's aperiodicity threshold: lower is stricter about calling a frame voiced. */
const YIN_THRESHOLD = 0.15;

/**
 * The pitch (fundamental frequency) at each time, in Hz, by YIN on the audio
 * decimated to 8 kHz; null where the frame isn't voiced.
 */
export function pitchTrack(
  samples: Float32Array,
  sampleRate: number,
  times: readonly number[],
): (number | null)[] {
  const rate = sampleRate / 2;
  const frame = Math.round(PITCH_FRAME_SEC * rate);
  const minLag = Math.floor(rate / PITCH_MAX_HZ);
  const maxLag = Math.ceil(rate / PITCH_MIN_HZ);
  const x = new Float64Array(frame + maxLag);
  const d = new Float64Array(maxLag + 1);
  return times.map((t) => {
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < x.length; i++) {
      // Average pairs of samples: a crude low-pass before decimating.
      const j = start + 2 * i;
      x[i] = ((samples[j] ?? 0) + (samples[j + 1] ?? 0)) / 2;
    }
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += x[i]! * x[i]!;
    if (energy / frame < 1e-6) return null;
    // YIN: the cumulative-mean-normalized difference function.
    let running = 0;
    d[0] = 1;
    for (let lag = 1; lag <= maxLag; lag++) {
      let diff = 0;
      for (let i = 0; i < frame; i++) {
        const v = x[i]! - x[i + lag]!;
        diff += v * v;
      }
      running += diff;
      d[lag] = running > 0 ? (diff * lag) / running : 1;
    }
    for (let lag = minLag; lag < maxLag; lag++) {
      if (d[lag]! < YIN_THRESHOLD) {
        while (lag + 1 < maxLag && d[lag + 1]! < d[lag]!) lag++;
        // Parabolic interpolation around the dip.
        const [a, b, c] = [d[lag - 1]!, d[lag]!, d[lag + 1]!];
        const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
        return rate / (lag + shift);
      }
    }
    return null;
  });
}

/** Seconds between the pitch frames {@link medianPitch} measures. */
export const PITCH_HOP_SEC = 0.02;

/**
 * The median pitch over the parts of [from, to) inside `speech`, in Hz, and
 * how many seconds of it were voiced; null pitch if under `minVoicedSecs`.
 */
export function medianPitch(
  samples: Float32Array,
  sampleRate: number,
  speech: readonly { start: number; end: number }[],
  from: number,
  to: number,
  minVoicedSecs = 0.2,
): { hz: number | null; voicedSecs: number } {
  const times: number[] = [];
  for (const s of speech)
    for (
      let t = Math.max(s.start, from);
      t < Math.min(s.end, to);
      t += PITCH_HOP_SEC
    )
      times.push(t);
  const voiced = pitchTrack(samples, sampleRate, times)
    .filter((hz): hz is number => hz !== null)
    .sort((a, b) => a - b);
  const voicedSecs = voiced.length * PITCH_HOP_SEC;
  return {
    hz:
      voicedSecs >= minVoicedSecs
        ? voiced[Math.floor(voiced.length / 2)]!
        : null,
    voicedSecs,
  };
}
