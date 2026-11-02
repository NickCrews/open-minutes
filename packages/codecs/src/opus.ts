import { createRequire } from "node:module";
import { OpusDecoder } from "opus-decoder";
import { SAMPLE_RATE, toInt16 } from "./wav";
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
 * The audio of a WebM/Opus file as 16 kHz mono samples, a batch (~20 s) at a
 * time, with the encoder's delay (pre-skip) and end padding trimmed:
 *
 * ```ts
 * for await (const samples of decodeOpusWebm(webm)) ...
 * ```
 *
 * Throws right away if `webm` has no Opus track this can decode.
 *
 * Decoding is libopus compiled to WebAssembly (opus-decoder), asked for 16 kHz
 * mono output directly; a stereo stream's channels are averaged. The same
 * input gives the same samples on every machine.
 */
export function decodeOpusWebm(webm: Uint8Array): AsyncIterable<Float32Array> {
  const track = readOpusTrack(webm);
  const head = track.opusHead;
  if (head.length < 19 || readAscii(head, 0, 8) !== "OpusHead") {
    throw new Error("WebM Opus track has no OpusHead");
  }
  const channels = head[9]!;
  if (head[18] !== 0 || channels > 2) {
    throw new Error(`Unsupported Opus channel layout (${channels} channels)`);
  }
  // In 48 kHz samples, as the OpusHead gives it.
  const preSkip = head[10]! | (head[11]! << 8);
  return decodeOpusTrack(track, preSkip);
}

async function* decodeOpusTrack(
  { packets, discardPaddingNs }: OpusTrack,
  preSkip: number,
): AsyncGenerator<Float32Array> {
  const decoder = new OpusDecoder({
    sampleRate: SAMPLE_RATE,
    // A mono decoder downmixes a stereo stream.
    channels: 1,
    streamCount: 1,
    coupledStreamCount: 0,
    channelMappingTable: [0],
    // opus-decoder applies pre-skip in output samples, but the header gives
    // it in 48 kHz samples.
    preSkip: Math.round((preSkip * SAMPLE_RATE) / OPUS_RATE),
  });
  await decoder.ready;
  try {
    // The encoder pads the last packet; the container says how much to drop.
    // That many samples are held back until the next batch, so the end of the
    // last one is never yielded.
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

/** Encoder settings for {@link encodeOpusWebm}. */
export interface OpusEncodeOptions {
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
 * Encodes 16 kHz mono samples, in chunks of any size, to a WebM/Opus file:
 *
 * ```ts
 * const smaller = await encodeOpusWebm(decodeOpusWebm(webm), { bitrate: 24_000 });
 * ```
 *
 * Encoding is libopus compiled to WebAssembly (@evan/opus's WebAssembly
 * build, not its native one), at its highest complexity, so the same samples
 * give the same bytes on every machine. The file decodes to exactly the
 * samples given, length included, and browsers can play and seek it.
 */
export async function encodeOpusWebm(
  samples: AsyncIterable<Float32Array>,
  { bitrate }: OpusEncodeOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new Encoder({
    channels: 1,
    sample_rate: SAMPLE_RATE,
    application: "audio",
  });
  const packets: Uint8Array[] = [];
  let total = 0;
  let lookahead: number;
  let silence: number;
  try {
    encoder.ctl(OPUS_SET_BITRATE, bitrate);
    encoder.ctl(OPUS_SET_COMPLEXITY, 10);
    /** The encoder's delay, in 16 kHz samples. */
    lookahead = encoder.ctl(OPUS_GET_LOOKAHEAD);

    /** Samples not yet encoded: less than one frame. */
    const frame = new Int16Array(FRAME);
    let buffered = 0;
    const add = (chunk: Float32Array) => {
      const pcm = new Int16Array(toInt16(chunk).buffer);
      let offset = 0;
      while (offset < pcm.length) {
        const n = Math.min(FRAME - buffered, pcm.length - offset);
        frame.set(pcm.subarray(offset, offset + n), buffered);
        buffered += n;
        offset += n;
        if (buffered === FRAME) {
          packets.push(encoder.encode(new Uint8Array(frame.buffer)));
          buffered = 0;
        }
      }
    };
    for await (const chunk of samples) {
      add(chunk);
      total += chunk.length;
    }
    // Silence after the end pushes the last samples through the encoder's
    // delay; the file says to drop it again.
    silence = Math.ceil((total + lookahead) / FRAME) * FRAME - total;
    add(new Float32Array(silence));
  } finally {
    encoder.drop();
  }

  const ns = (n: number) => Math.round((n / SAMPLE_RATE) * 1e9);
  const opusHead = new Uint8Array(19);
  const head = new DataView(opusHead.buffer);
  opusHead.set(new TextEncoder().encode("OpusHead"));
  head.setUint8(8, 1); // version
  head.setUint8(9, 1); // channels
  head.setUint16(10, (lookahead * OPUS_RATE) / SAMPLE_RATE, true);
  head.setUint32(12, SAMPLE_RATE, true); // the input's rate, for information
  return writeOpusTrack(
    { opusHead, packets, discardPaddingNs: ns(silence - lookahead) },
    {
      packetMs: (FRAME / SAMPLE_RATE) * 1000,
      durationMs: (total / SAMPLE_RATE) * 1000,
      codecDelayNs: ns(lookahead),
    },
  );
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
  return encodeOpusWebm(decodeOpusWebm(webm), { bitrate: 24_000 });
}

function readAscii(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, end));
}
