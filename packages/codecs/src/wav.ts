import { open, readFile, rename, rm } from "node:fs/promises";

/** The sample rate the transcription model wants. */
export const SAMPLE_RATE = 16_000;

/** Float samples in [-1, 1] as 16-bit PCM, rounded and clipped as ffmpeg does. */
export function toInt16(samples: Float32Array): Uint8Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768)));
  }
  return new Uint8Array(pcm.buffer);
}

/** The sample encodings this package reads, by their WAV format code. */
const FORMAT_CODES = { pcm: 1, float: 3 } as const;

/** Integer PCM, or IEEE float. */
export type WavAudioFormat = keyof typeof FORMAT_CODES;

/** The fields of a canonical 44-byte WAV header. */
export interface WavMetadata {
  audioFormat: WavAudioFormat;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

interface WavHeader extends WavMetadata {
  dataBytes: number;
}

/** The WAV format the audio models read: 16 kHz mono 16-bit PCM. */
const DEFAULT_WAV_METADATA = {
  audioFormat: "pcm",
  channels: 1,
  sampleRate: SAMPLE_RATE,
  bitsPerSample: 16,
} as const satisfies WavMetadata;

/**
 * WAV metadata: the format the audio models read (see
 * {@link DEFAULT_WAV_METADATA}), with `overrides` applied.
 */
export function wavMetadata(overrides?: Partial<WavMetadata>): WavMetadata {
  return { ...DEFAULT_WAV_METADATA, ...overrides };
}

/** Whether `meta` is the format the audio models read. */
export function isModelWav(meta: WavMetadata): boolean {
  return (
    meta.audioFormat === DEFAULT_WAV_METADATA.audioFormat &&
    meta.channels === DEFAULT_WAV_METADATA.channels &&
    meta.sampleRate === DEFAULT_WAV_METADATA.sampleRate &&
    meta.bitsPerSample === DEFAULT_WAV_METADATA.bitsPerSample
  );
}

/**
 * The metadata in `bytes`, which start with a canonical 44-byte header (a
 * RIFF/WAVE file whose only chunks are a 16-byte "fmt " then "data").
 */
function readHeader(bytes: Uint8Array): WavHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  const canonical =
    bytes.length >= 44 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 16) === "WAVEfmt " &&
    view.getUint32(16, true) === 16 && // fmt chunk size
    ascii(36, 40) === "data";
  if (!canonical) throw new Error("not a canonical 44-byte WAV header");
  const code = view.getUint16(20, true);
  const audioFormat = (Object.keys(FORMAT_CODES) as WavAudioFormat[]).find(
    (format) => FORMAT_CODES[format] === code,
  );
  if (!audioFormat) throw new Error(`unsupported WAV format code ${code}`);
  return {
    audioFormat,
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  };
}

/** A canonical 44-byte header for `samples` frames in the format `meta`. */
function writeHeader(meta: WavMetadata, samples: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[offset + i] = s.charCodeAt(i);
  };
  const blockAlign = meta.channels * (meta.bitsPerSample / 8);
  const dataBytes = samples * blockAlign;
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, FORMAT_CODES[meta.audioFormat], true);
  view.setUint16(22, meta.channels, true);
  view.setUint32(24, meta.sampleRate, true);
  view.setUint32(28, meta.sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, meta.bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * Writes 16 kHz mono `samples` to `dest` as 16-bit WAV, a chunk at a time.
 * Writes beside `dest` first, so a failure (including one from `samples`)
 * never leaves a partial file at `dest`.
 */
export async function writeWav(
  samples: AsyncIterable<Float32Array>,
  dest: string,
) {
  const meta = wavMetadata();
  const part = `${dest}.part`;
  const file = await open(part, "w");
  try {
    let written = 0;
    await file.write(writeHeader(meta, 0), 0, 44, 0);
    for await (const chunk of samples) {
      const pcm = toInt16(chunk);
      await file.write(pcm, 0, pcm.byteLength, 44 + written * 2);
      written += chunk.length;
    }
    await file.write(writeHeader(meta, written), 0, 44, 0);
    await file.close();
    await rename(part, dest);
  } finally {
    await file.close().catch(() => {});
    await rm(part, { force: true });
  }
}

/**
 * The metadata and samples of a WAV written by this package (canonical 44-byte
 * header, in the format the audio models read). For tests, so this package
 * needn't depend on `@open-minutes/audio/wav`, which depends on it.
 */
export async function readCanonicalWav(
  path: string,
): Promise<WavMetadata & { samples: Float32Array }> {
  const bytes = await readFile(path);
  const notCanonical = (cause?: unknown) =>
    new Error(`${path} is not a canonical 16 kHz 16-bit mono PCM WAV`, {
      cause,
    });
  let header: WavHeader;
  try {
    header = readHeader(bytes);
  } catch (error) {
    throw notCanonical(error);
  }
  if (!isModelWav(header) || header.dataBytes !== bytes.length - 44) {
    throw notCanonical();
  }
  const { dataBytes: _, ...meta } = header;
  const pcm = new Int16Array(
    bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length),
  );
  return {
    ...meta,
    samples: Float32Array.from(pcm, (s) => s / 32768),
  };
}
