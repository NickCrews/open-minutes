import { createRequire } from "node:module";
import { OpusDecoder } from "opus-decoder";
import { SAMPLE_RATE, toInt16, writeWav } from "./wav";
import { type OpusTrack, readOpusTrack, writeOpusTrack } from "./webm";

/** A libopus encoder from @evan/opus. */
interface Encoder {
  /** An encoder CTL (opus_defines.h): sets with `value`, else gets. */
  ctl(cmd: number, value?: number): number;
  /** One frame of 16-bit PCM, as bytes, to one Opus packet. */
  encode(pcm: Uint8Array): Uint8Array;
  /** Frees the encoder. */
  drop(): void;
}

// @evan/opus's WebAssembly build. Its main entry point prefers a native addon,
// whose output can differ by machine, and its types cover only that.
const { Encoder } = createRequire(import.meta.url)(
  "@evan/opus/wasm/index.js",
) as {
  Encoder: new (options: {
    channels: 1 | 2;
    sample_rate: number;
    application: "voip" | "audio" | "restricted_lowdelay";
  }) => Encoder;
};

/** Opus timestamps (pre-skip) are always in 48 kHz samples. */
const OPUS_RATE = 48_000;
/** Packets decoded per batch: ~20 s of audio, so memory stays flat. */
const BATCH = 1_000;

/**
 * The audio of a WebM/Opus file as 16 kHz mono samples. Iterate it for the
 * samples, a batch (~20 s) at a time, with the encoder's delay (pre-skip) and
 * end padding trimmed:
 *
 * ```ts
 * for await (const samples of new OpusReader(webm)) ...
 * ```
 *
 * Decoding is libopus compiled to WebAssembly (opus-decoder), asked for 16 kHz
 * mono output directly; a stereo stream's channels are averaged. The same
 * input gives the same samples on every machine.
 */
export class OpusReader implements AsyncIterable<Float32Array> {
  readonly #track: OpusTrack;
  /** In 48 kHz samples, as the OpusHead gives it. */
  readonly #preSkip: number;

  /** Throws if `webm` has no Opus track this can decode. */
  constructor(webm: Uint8Array) {
    this.#track = readOpusTrack(webm);
    const head = this.#track.opusHead;
    if (head.length < 19 || readAscii(head, 0, 8) !== "OpusHead") {
      throw new Error("WebM Opus track has no OpusHead");
    }
    const channels = head[9]!;
    this.#preSkip = head[10]! | (head[11]! << 8);
    if (head[18] !== 0 || channels > 2) {
      throw new Error(`Unsupported Opus channel layout (${channels} channels)`);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Float32Array> {
    const { packets, discardPaddingNs } = this.#track;
    const decoder = new OpusDecoder({
      sampleRate: SAMPLE_RATE,
      // A mono decoder downmixes a stereo stream.
      channels: 1,
      streamCount: 1,
      coupledStreamCount: 0,
      channelMappingTable: [0],
      // opus-decoder applies pre-skip in output samples, but the header gives
      // it in 48 kHz samples.
      preSkip: Math.round((this.#preSkip * SAMPLE_RATE) / OPUS_RATE),
    });
    await decoder.ready;
    try {
      // The encoder pads the last packet; the container says how much to
      // drop. That many samples are held back until the next batch, so the
      // end of the last one is never yielded.
      const padding = Math.round((discardPaddingNs * SAMPLE_RATE) / 1e9);
      let held = new Float32Array(0);
      for (let i = 0; i < packets.length; i += BATCH) {
        const out = decoder.decodeFrames(packets.slice(i, i + BATCH));
        if (out.errors.length > 0) {
          throw new Error(`Opus decode failed: ${out.errors[0]!.message}`);
        }
        const decoded = out.channelData[0]!.subarray(0, out.samplesDecoded);
        const all = new Float32Array(held.length + decoded.length);
        all.set(held);
        all.set(decoded, held.length);
        const ready = Math.max(0, all.length - padding);
        if (ready > 0) yield all.subarray(0, ready);
        held = all.slice(ready);
      }
    } finally {
      decoder.free();
    }
  }
}

/** Encoder settings for {@link OpusWriter}. */
export interface OpusWriterOptions {
  /** Bits per second; libopus varies it around this (VBR). */
  bitrate: number;
}

/** 20 ms, libopus's default and best-tuned frame size. */
const FRAME = SAMPLE_RATE / 50;
// libopus's encoder CTLs (opus_defines.h).
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_COMPLEXITY = 4010;
const OPUS_GET_LOOKAHEAD = 4027;

/**
 * Encodes 16 kHz mono samples to a WebM/Opus file. {@link write} the samples
 * in chunks of any size, then {@link end} for the file:
 *
 * ```ts
 * const writer = new OpusWriter({ bitrate: 24_000 });
 * for await (const samples of new OpusReader(webm)) writer.write(samples);
 * const smaller = writer.end();
 * ```
 *
 * Encoding is libopus compiled to WebAssembly (@evan/opus's WebAssembly
 * build, not its native one), at its highest complexity, so the same samples
 * give the same bytes on every machine. The file decodes to exactly the
 * samples written, length included, and browsers can play and seek it.
 */
export class OpusWriter {
  readonly #encoder: Encoder;
  /** The encoder's delay, in 16 kHz samples. */
  readonly #lookahead: number;
  readonly #packets: Uint8Array[] = [];
  /** Samples not yet encoded: less than one frame. */
  readonly #frame = new Int16Array(FRAME);
  #buffered = 0;
  #samples = 0;
  #ended = false;

  constructor({ bitrate }: OpusWriterOptions) {
    this.#encoder = new Encoder({
      channels: 1,
      sample_rate: SAMPLE_RATE,
      application: "audio",
    });
    this.#encoder.ctl(OPUS_SET_BITRATE, bitrate);
    this.#encoder.ctl(OPUS_SET_COMPLEXITY, 10);
    this.#lookahead = this.#encoder.ctl(OPUS_GET_LOOKAHEAD);
  }

  /** Adds samples to the end. */
  write(samples: Float32Array) {
    if (this.#ended) throw new Error("OpusWriter has already ended");
    this.#samples += samples.length;
    const pcm = new Int16Array(toInt16(samples).buffer);
    let offset = 0;
    while (offset < pcm.length) {
      const n = Math.min(FRAME - this.#buffered, pcm.length - offset);
      this.#frame.set(pcm.subarray(offset, offset + n), this.#buffered);
      this.#buffered += n;
      offset += n;
      if (this.#buffered === FRAME) this.#encodeFrame();
    }
  }

  /** The WebM file of everything written. The writer can't be used after. */
  end(): Uint8Array<ArrayBuffer> {
    if (this.#ended) throw new Error("OpusWriter has already ended");
    // Silence after the end pushes the last samples through the encoder's
    // delay; the file says to drop it again.
    const silence =
      Math.ceil((this.#samples + this.#lookahead) / FRAME) * FRAME -
      this.#samples;
    this.write(new Float32Array(silence));
    this.#samples -= silence;
    this.#ended = true;
    this.#encoder.drop();

    const ns = (samples: number) => Math.round((samples / SAMPLE_RATE) * 1e9);
    const opusHead = new Uint8Array(19);
    const head = new DataView(opusHead.buffer);
    opusHead.set(new TextEncoder().encode("OpusHead"));
    head.setUint8(8, 1); // version
    head.setUint8(9, 1); // channels
    head.setUint16(10, (this.#lookahead * OPUS_RATE) / SAMPLE_RATE, true);
    head.setUint32(12, SAMPLE_RATE, true); // the input's rate, for information
    return writeOpusTrack(
      {
        opusHead,
        packets: this.#packets,
        discardPaddingNs: ns(silence - this.#lookahead),
      },
      {
        packetMs: (FRAME / SAMPLE_RATE) * 1000,
        durationMs: (this.#samples / SAMPLE_RATE) * 1000,
        codecDelayNs: ns(this.#lookahead),
      },
    );
  }

  #encodeFrame() {
    const bytes = new Uint8Array(this.#frame.buffer);
    this.#packets.push(this.#encoder.encode(bytes));
    this.#buffered = 0;
  }
}

/**
 * Decodes Opus-in-WebM audio to `dest` as 16 kHz mono 16-bit WAV, the format
 * the transcription model wants; see {@link OpusReader}. Writes beside `dest`
 * first, so an interrupted decode never leaves a partial file at `dest`.
 */
export async function webmOpusToWav(webm: Uint8Array, dest: string) {
  await writeWav(new OpusReader(webm), dest);
}

/**
 * Opus-in-WebM audio re-encoded for speech: 16 kHz mono at 24 kbps, ~11 MB
 * per hour, plenty for the models, which take 16 kHz mono. On speech it
 * decodes to the same length as the original, at zero lag, with correlation
 * ~0.997. A 90-minute meeting takes about a minute.
 */
export async function encodeSpeechWebm(
  webm: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = new OpusWriter({ bitrate: 24_000 });
  for await (const samples of new OpusReader(webm)) writer.write(samples);
  return writer.end();
}

function readAscii(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, end));
}
