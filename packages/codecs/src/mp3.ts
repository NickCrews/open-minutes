import { MPEGDecoder } from "mpg123-decoder";
import { Resampler } from "./resample";
import { SAMPLE_RATE } from "./wav";

/** Input fed to the decoder at a time, so a large buffer isn't one huge call. */
const CHUNK = 1 << 16;

/**
 * MP3 audio (akleg.gov's "FTR" recordings are 24 kHz stereo at 64 kbps) as
 * 16 kHz mono samples, a decoded chunk at a time.
 *
 * `mp3` is the whole file or a stream of its bytes (such as a fetch body), so a
 * multi-hour recording is decoded as it downloads, in constant memory.
 * Decoding is libmpg123 compiled to WebAssembly (mpg123-decoder), so it needs
 * no system ffmpeg and gives the same samples on every machine. Unlike Opus,
 * MP3 can't be decoded straight to 16 kHz, so the channels are averaged and
 * then resampled with {@link Resampler}.
 */
export async function* decodeMp3(
  mp3: Uint8Array | AsyncIterable<Uint8Array>,
): AsyncIterable<Float32Array> {
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
