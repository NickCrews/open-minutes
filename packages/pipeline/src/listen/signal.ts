// Spectrogram and pitch for render_audio: plain DSP over the 16 kHz samples.

/** In-place radix-2 FFT of (re, im), whose length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

const FFT_SIZE = 512; // 32 ms at 16 kHz
const hann = Float64Array.from(
  { length: FFT_SIZE },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)),
);

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/** Triangular mel filters over the FFT bins, lowest band first. */
function melFilters(bands: number, sampleRate: number, maxHz: number) {
  const bins = FFT_SIZE / 2 + 1;
  const edges = Array.from({ length: bands + 2 }, (_, i) =>
    melToHz((hzToMel(maxHz) * i) / (bands + 1)),
  ).map((hz) => (hz / sampleRate) * FFT_SIZE);
  return Array.from({ length: bands }, (_, b) => {
    const [lo, mid, hi] = [edges[b]!, edges[b + 1]!, edges[b + 2]!];
    const weights = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      if (k > lo && k <= mid) weights[k] = (k - lo) / (mid - lo);
      else if (k > mid && k < hi) weights[k] = (hi - k) / (hi - mid);
    }
    return weights;
  });
}

export const MEL_MAX_HZ = 8000;

/** Height in [0, 1] of `hz` on the spectrogram's mel axis (0 at the bottom). */
export function melPosition(hz: number): number {
  return hzToMel(hz) / hzToMel(MEL_MAX_HZ);
}

/**
 * Log-mel power, one column per entry of `times` (seconds; each column
 * averages the frames up to the next time), `bands` rows, lowest band first,
 * in dB.
 */
export function melSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  times: readonly number[],
  bands: number,
): Float64Array[] {
  const filters = melFilters(bands, sampleRate, MEL_MAX_HZ);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const hop = FFT_SIZE / 2;
  return times.map((t, c) => {
    const start = Math.floor(t * sampleRate);
    const end = Math.max(
      start + 1,
      Math.floor((times[c + 1] ?? t + hop / sampleRate) * sampleRate),
    );
    const power = new Float64Array(FFT_SIZE / 2 + 1);
    let frames = 0;
    for (let s = start; s < end; s += hop) {
      for (let i = 0; i < FFT_SIZE; i++) {
        re[i] = (samples[s - FFT_SIZE / 2 + i] ?? 0) * hann[i]!;
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < power.length; k++)
        power[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
      frames++;
    }
    return Float64Array.from(filters, (w) => {
      let e = 0;
      for (let k = 0; k < w.length; k++) e += w[k]! * power[k]!;
      return 10 * Math.log10(e / frames + 1e-10);
    });
  });
}

const PITCH_MIN_HZ = 60;
const PITCH_MAX_HZ = 400;
const PITCH_FRAME_SEC = 0.04;
/** YIN's aperiodicity threshold: lower is stricter about calling a frame voiced. */
const YIN_THRESHOLD = 0.15;

/**
 * The pitch (fundamental frequency) at each time, in Hz, by YIN on the audio
 * decimated to 8 kHz; null where the frame isn't voiced. A person's pitch
 * range stays put through a meeting, so a jump in it is a cue the speaker
 * changed.
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
