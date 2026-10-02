import { open, rename, rm } from "node:fs/promises";
import { OpusDecoder } from "opus-decoder";

/** The sample rate the transcription model wants. */
const SAMPLE_RATE = 16_000;
/** Opus timestamps (pre-skip) are always in 48 kHz samples. */
const OPUS_RATE = 48_000;
/** Packets decoded per batch: ~20 s of audio, so memory stays flat. */
const BATCH = 1_000;

/**
 * Decodes Opus-in-WebM audio (YouTube's format 251, or the object store's
 * speech-quality re-encode of it) to `dest` as 16 kHz mono 16-bit WAV, the
 * format the transcription model wants.
 *
 * Decoding is libopus compiled to WebAssembly (opus-decoder), asked for 16 kHz
 * mono output directly, so it needs no system ffmpeg, and the same input gives
 * the same bytes on every machine. Writes beside `dest` first, so an
 * interrupted decode never leaves a partial file at `dest`.
 */
export async function webmOpusToWav(webm: Uint8Array, dest: string) {
  const { packets, opusHead, discardPaddingNs } = demuxOpus(webm);
  if (opusHead.length < 19 || readAscii(opusHead, 0, 8) !== "OpusHead") {
    throw new Error("WebM Opus track has no OpusHead");
  }
  const channels = opusHead[9]!;
  const preSkip = opusHead[10]! | (opusHead[11]! << 8);
  if (opusHead[18] !== 0 || channels > 2) {
    throw new Error(`Unsupported Opus channel layout (${channels} channels)`);
  }

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

  const part = `${dest}.part`;
  const file = await open(part, "w");
  try {
    let samples = 0;
    await file.write(wavHeader(0), 0, 44, 0);
    for (let i = 0; i < packets.length; i += BATCH) {
      const out = decoder.decodeFrames(packets.slice(i, i + BATCH));
      if (out.errors.length > 0) {
        throw new Error(`Opus decode failed: ${out.errors[0]!.message}`);
      }
      const pcm = toInt16(out.channelData[0]!.subarray(0, out.samplesDecoded));
      await file.write(pcm, 0, pcm.byteLength, 44 + samples * 2);
      samples += out.samplesDecoded;
    }
    // The encoder pads the last packet; the container says how much to drop.
    const padding = Math.round((discardPaddingNs * SAMPLE_RATE) / 1e9);
    samples = Math.max(0, samples - padding);
    await file.truncate(44 + samples * 2);
    await file.write(wavHeader(samples), 0, 44, 0);
    await file.close();
    await rename(part, dest);
  } finally {
    decoder.free();
    await file.close().catch(() => {});
    await rm(part, { force: true });
  }
}

/** Float samples in [-1, 1] as 16-bit PCM, rounded and clipped as ffmpeg does. */
function toInt16(samples: Float32Array): Uint8Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768)));
  }
  return new Uint8Array(pcm.buffer);
}

/** A canonical 44-byte header for `samples` of 16-bit mono PCM. */
function wavHeader(samples: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return header;
}

// Matroska element IDs (https://www.matroska.org/technical/elements.html).
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const BLOCK_GROUP = 0xa0;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const SIMPLE_BLOCK = 0xa3;
const BLOCK = 0xa1;
const DISCARD_PADDING = 0x75a2;
/** Elements whose children are read; every other element's body is skipped. */
const DESCEND = new Set([SEGMENT, CLUSTER, BLOCK_GROUP, TRACKS, TRACK_ENTRY]);

/**
 * The Opus packets of a WebM file's first Opus track, its OpusHead, and the
 * total DiscardPadding (end-of-stream trim). Reads the elements in one flat
 * pass, stepping into container elements rather than over them, so clusters
 * of unknown size (as in streamed WebM) work too.
 */
function demuxOpus(buf: Uint8Array) {
  const packets: Uint8Array[] = [];
  const codecPrivate = new Map<number | undefined, Uint8Array>();
  let opusTrack: number | undefined;
  let trackNumber: number | undefined;
  let discardPaddingNs = 0;
  let pos = 0;
  while (pos < buf.length) {
    const id = readVint(buf, pos, true);
    pos += id.length;
    const size = readVint(buf, pos, false);
    pos += size.length;
    if (DESCEND.has(id.value)) continue;
    if (size.unknown) throw new Error(`WebM element ${id.value} has no size`);
    const end = pos + size.value;
    const body = buf.subarray(pos, end);
    switch (id.value) {
      case TRACK_NUMBER:
        trackNumber = readUint(body);
        break;
      case CODEC_ID:
        if (
          readAscii(body, 0, body.length) === "A_OPUS" &&
          opusTrack === undefined
        ) {
          opusTrack = trackNumber;
        }
        break;
      case CODEC_PRIVATE:
        codecPrivate.set(trackNumber, body);
        break;
      case SIMPLE_BLOCK:
      case BLOCK: {
        const track = readVint(body, 0, false);
        if (track.value !== opusTrack) break;
        const flags = body[track.length + 2]!;
        if (flags & 0x06) throw new Error("Laced WebM blocks are unsupported");
        packets.push(body.subarray(track.length + 3));
        break;
      }
      case DISCARD_PADDING:
        discardPaddingNs += readInt(body);
        break;
    }
    pos = end;
  }
  const opusHead = codecPrivate.get(opusTrack);
  if (opusTrack === undefined || !opusHead) {
    throw new Error("No Opus track in the WebM file");
  }
  return { packets, opusHead, discardPaddingNs };
}

/**
 * An EBML variable-length integer. IDs keep their length-marker bit; sizes
 * drop it, and an all-ones size means "unknown".
 */
function readVint(buf: Uint8Array, pos: number, isId: boolean) {
  const first = buf[pos];
  if (first === undefined || first === 0) {
    throw new Error(`Malformed WebM at byte ${pos}`);
  }
  const length = Math.clz32(first) - 23;
  const mask = 0xff >> length;
  let value = isId ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    const byte = buf[pos + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !isId && allOnes };
}

function readUint(body: Uint8Array): number {
  let value = 0;
  for (const byte of body) value = value * 256 + byte;
  return value;
}

function readInt(body: Uint8Array): number {
  const unsigned = readUint(body);
  const signBit = 2 ** (body.length * 8 - 1);
  return body.length > 0 && unsigned >= signBit
    ? unsigned - 2 * signBit
    : unsigned;
}

function readAscii(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, end));
}
