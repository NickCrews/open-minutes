import type { WaveForm } from "@open-minutes/audio/wav";
import type { Span } from "./activity";

// Pitch (fundamental frequency) by YIN (de Cheveigné & Kawahara, 2002). One
// person's pitch stays in their own range through a meeting, so it tells a
// low voice from a high one in stretches too short for a voiceprint.

/** The lowest and highest pitch looked for: adult speech. */
export const MIN_PITCH_HZ = 60;
export const MAX_PITCH_HZ = 400;
/** Seconds of audio per pitch estimate: two periods of the lowest pitch. */
const FRAME_SEC = 0.04;
/** Seconds between the frames {@link medianPitch} measures. */
const HOP_SEC = 0.02;
/** YIN's threshold: a frame is voiced if its normalized difference dips below it. */
const THRESHOLD = 0.25;
/**
 * Prefer twice the period when d' there is under this fraction of d' at the
 * period: the signal repeats much better over two of what looked like
 * periods...
 */
const OCTAVE_RATIO = 0.5;
/**
 * ...unless d' at the period is already under this: a clean tone repeats
 * almost perfectly at either, and the ratio of two near-zeros means nothing.
 */
const CLEAN_DIP = 0.05;
/** Frames quieter than this mean square are silence. */
const MIN_ENERGY = 1e-6;
/** Speech pitch needs no more than 8 kHz, so frames are halved in rate first. */
const DECIMATION = 2;

/**
 * The pitch of the frame of `wave` starting at `at` seconds, in Hz, or null
 * where it isn't voiced (silence, noise, a consonant).
 */
export function pitchAt(wave: WaveForm, at: number): number | null {
  const rate = wave.sampleRate / DECIMATION;
  const frame = Math.round(FRAME_SEC * rate);
  const maxLag = Math.ceil(rate / MIN_PITCH_HZ);

  // The frame plus the longest lag, decimated: each sample the mean of
  // DECIMATION input samples (a crude low-pass, enough below 400 Hz).
  const x = new Float64Array(frame + maxLag + 1);
  const first = Math.floor(at * wave.sampleRate);
  if (first < 0 || first + x.length * DECIMATION > wave.samples.length)
    return null;
  for (let i = 0; i < x.length; i++) {
    let sum = 0;
    for (let j = 0; j < DECIMATION; j++)
      sum += wave.samples[first + i * DECIMATION + j]!;
    x[i] = sum / DECIMATION;
  }
  let energy = 0;
  for (let i = 0; i < frame; i++) energy += x[i]! * x[i]!;
  if (energy / frame < MIN_ENERGY) return null;

  // The cumulative-mean-normalized difference d'(lag): 1 at lag 0, dipping
  // toward 0 at each period of a periodic signal.
  const d = new Float64Array(maxLag + 2);
  d[0] = 1;
  let running = 0;
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let diff = 0;
    for (let i = 0; i < frame; i++) {
      const v = x[i]! - x[i + lag]!;
      diff += v * v;
    }
    running += diff;
    d[lag] = running > 0 ? (diff * lag) / running : 1;
  }
  // The first dip below the threshold, at its bottom: the period. Taking the
  // first rather than the deepest keeps a multiple of it (half the pitch)
  // from winning. The search starts below the range, so a tone too high for
  // speech is seen as that, not as a multiple of its period in range.
  for (let lag = 2; lag <= maxLag; lag++) {
    if (d[lag]! >= THRESHOLD) continue;
    lag = bottom(d, lag, maxLag);
    // A voice whose second harmonic is strong almost repeats at half its
    // period. If it repeats much better at the full period, that's the one.
    const double = bottom(
      d,
      Math.min(2 * lag - 2, maxLag),
      Math.min(2 * lag + 2, maxLag),
    );
    if (
      2 * lag + 2 <= maxLag &&
      d[lag]! > CLEAN_DIP &&
      d[double]! < OCTAVE_RATIO * d[lag]!
    )
      lag = double;
    // Parabolic interpolation between lags, for a pitch finer than the lag.
    const [a, b, c] = [d[lag - 1]!, d[lag]!, d[lag + 1]!];
    const curve = a - 2 * b + c;
    const shift = curve > 0 ? (a - c) / (2 * curve) : 0;
    const hz = rate / (lag + shift);
    return hz >= MIN_PITCH_HZ && hz <= MAX_PITCH_HZ ? hz : null;
  }
  return null;
}

/** The lag of the lowest d' at or after `from` before d' rises again, up to `to`. */
function bottom(d: Float64Array, from: number, to: number): number {
  let lag = from;
  while (lag < to && d[lag + 1]! < d[lag]!) lag++;
  return lag;
}

/**
 * The median pitch of the speech in `spans` (clipped to [from, to)), in Hz,
 * rounded; null with under `minVoicedSecs` of voiced frames to go on.
 */
export function medianPitch(
  wave: WaveForm,
  spans: readonly Span[],
  from: number,
  to: number,
  minVoicedSecs = 0.25,
): number | null {
  const voiced: number[] = [];
  for (const s of spans) {
    const end = Math.min(s.end, to) - FRAME_SEC;
    for (let t = Math.max(s.start, from); t <= end; t += HOP_SEC) {
      const hz = pitchAt(wave, t);
      if (hz !== null) voiced.push(hz);
    }
  }
  if (voiced.length * HOP_SEC < minVoicedSecs) return null;
  voiced.sort((a, b) => a - b);
  const mid = voiced.length / 2;
  const median =
    voiced.length % 2
      ? voiced[Math.floor(mid)]!
      : (voiced[mid - 1]! + voiced[mid]!) / 2;
  return Math.round(median);
}
