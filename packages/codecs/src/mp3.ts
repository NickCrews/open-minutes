import { MPEGDecoder } from "mpg123-decoder";
import { SAMPLE_RATE, writeWav } from "./wav";

/** Input fed to the decoder at a time, so a large buffer isn't one huge call. */
const CHUNK = 1 << 16;

/**
 * Decodes MP3 audio (akleg.gov's "FTR" recordings are 24 kHz stereo at
 * 64 kbps) to `dest` as 16 kHz mono 16-bit WAV, the format the transcription
 * model wants.
 *
 * `mp3` is the whole file or a stream of its bytes (such as a fetch body), so a
 * multi-hour recording is decoded as it downloads, in constant memory.
 * Decoding is libmpg123 compiled to WebAssembly (mpg123-decoder), so it needs
 * no system ffmpeg and gives the same bytes on every machine. Unlike Opus,
 * MP3 can't be decoded straight to 16 kHz, so the channels are averaged and
 * then resampled with {@link Resampler}. Writes beside `dest` first, so an
 * interrupted decode never leaves a partial file at `dest`.
 */
export async function mp3ToWav(
  mp3: Uint8Array | AsyncIterable<Uint8Array>,
  dest: string,
) {
  await writeWav(decodeMp3(mp3), dest);
}

/** `mp3`'s audio as 16 kHz mono samples; see {@link mp3ToWav}. */
async function* decodeMp3(mp3: Uint8Array | AsyncIterable<Uint8Array>) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    let resampler: Resampler | undefined;
    for await (const bytes of chunks(mp3)) {
      const out = decoder.decode(bytes);
      if (out.errors.length > 0) {
        throw new Error(`MP3 decode failed: ${out.errors[0]!.message}`);
      }
      if (out.samplesDecoded === 0) continue;
      resampler ??= new Resampler(out.sampleRate, SAMPLE_RATE);
      if (out.sampleRate !== resampler.from) {
        throw new Error(
          `MP3 sample rate changed mid-stream (${resampler.from} to ${out.sampleRate} Hz)`,
        );
      }
      yield resampler.push(downmix(out.channelData, out.samplesDecoded));
    }
    if (!resampler) throw new Error("No MP3 audio in the input");
    yield resampler.flush();
  } finally {
    decoder.free();
  }
}

async function* chunks(mp3: Uint8Array | AsyncIterable<Uint8Array>) {
  if (!(mp3 instanceof Uint8Array)) {
    for await (const piece of mp3) {
      for (let i = 0; i < piece.length; i += CHUNK) {
        yield piece.subarray(i, i + CHUNK);
      }
    }
    return;
  }
  for (let i = 0; i < mp3.length; i += CHUNK) yield mp3.subarray(i, i + CHUNK);
}

/** The average of the first `length` samples of each channel. */
function downmix(channels: Float32Array[], length: number): Float32Array {
  if (channels.length === 1) return channels[0]!.slice(0, length);
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i]! += channel[i]!;
  }
  for (let i = 0; i < length; i++) mono[i]! /= channels.length;
  return mono;
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
