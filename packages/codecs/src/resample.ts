import type { WaveForm } from "./waveform";

/**
 * `wave` at `sampleRate` Hz, with {@link Resampler}; `wave` itself if it's
 * already at that rate.
 */
export function resample(wave: WaveForm, sampleRate: number): WaveForm {
  if (wave.sampleRate === sampleRate) return wave;
  const resampler = new Resampler(wave.sampleRate, sampleRate);
  const head = resampler.push(wave.samples);
  const tail = resampler.flush();
  const samples = new Float32Array(head.length + tail.length);
  samples.set(head);
  samples.set(tail, head.length);
  return { samples, sampleRate };
}

/** Taps on each side of an output sample, at the input rate when upsampling. */
const HALF_TAPS = 16;

/**
 * Streaming windowed-sinc resampling of mono samples from `from` Hz to `to`
 * Hz, low-passed at the lower Nyquist frequency so downsampling doesn't alias.
 *
 * The ratio is rational, so output sample `i` sits at input position
 * `i * M / L` (`L/M` being `to/from` in lowest terms), whose fractional part
 * takes only `L` values. The Hann-windowed sinc kernel for each is computed
 * once, normalized to unit gain at DC. For 24 kHz to 16 kHz that's 2 kernels
 * of 49 taps.
 *
 * Samples before the start and after the end of the stream count as silence,
 * and the output has `floor(inputLength * to / from)` samples.
 */
export class Resampler {
  readonly from: number;
  readonly to: number;
  private readonly L: number;
  private readonly M: number;
  private readonly halfWidth: number;
  private readonly kernels: Float32Array[];
  /** Input not yet fully consumed, starting at absolute input index `start`. */
  private pending = new Float32Array(0);
  private start = 0;
  /** Total input samples pushed. */
  private received = 0;
  /** Absolute index of the next output sample. */
  private next = 0;

  constructor(from: number, to: number) {
    this.from = from;
    this.to = to;
    const g = gcd(from, to);
    this.L = to / g;
    this.M = from / g;
    const cutoff = Math.min(1, to / from); // as a fraction of the input Nyquist
    this.halfWidth = Math.ceil(HALF_TAPS / cutoff);
    this.kernels = Array.from({ length: this.L }, (_, phase) => {
      // Tap k weighs input sample base + k - halfWidth + 1, where the output
      // sits at base + phase / L.
      const taps = new Float32Array(2 * this.halfWidth);
      let sum = 0;
      for (let k = 0; k < taps.length; k++) {
        const x = k - this.halfWidth + 1 - phase / this.L;
        const sinc =
          x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
        const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / this.halfWidth);
        taps[k] = Math.abs(x) >= this.halfWidth ? 0 : sinc * window;
        sum += taps[k]!;
      }
      for (let k = 0; k < taps.length; k++) taps[k]! /= sum;
      return taps;
    });
  }

  /** Resamples the next stretch of input; returns what's ready of the output. */
  push(samples: Float32Array): Float32Array {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    this.pending = joined;
    this.received += samples.length;
    return this.drain(false);
  }

  /** The rest of the output, once the input has ended. */
  flush(): Float32Array {
    return this.drain(true);
  }

  private drain(final: boolean): Float32Array {
    const { L, M, halfWidth } = this;
    const total = Math.floor((this.received * L) / M);
    const out: number[] = [];
    for (;;) {
      const i = this.next;
      if (final && i >= total) break;
      const base = Math.floor((i * M) / L);
      // The last input sample this output needs.
      if (!final && base + halfWidth >= this.received) break;
      const kernel = this.kernels[(i * M) % L]!;
      const first = base - halfWidth + 1;
      let sum = 0;
      for (let k = 0; k < kernel.length; k++) {
        const j = first + k - this.start;
        if (j < 0 || j >= this.pending.length) continue;
        sum += this.pending[j]! * kernel[k]!;
      }
      out.push(sum);
      this.next++;
    }
    // Drop input no later output can reach.
    const keepFrom = Math.floor((this.next * M) / L) - halfWidth + 1;
    if (keepFrom > this.start) {
      this.pending = this.pending.slice(
        Math.min(keepFrom - this.start, this.pending.length),
      );
      this.start = keepFrom;
    }
    return Float32Array.from(out);
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
