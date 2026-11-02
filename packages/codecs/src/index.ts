import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { decodeMp3 } from "./mp3";
import { decodeOpusWebm } from "./opus";
import { readWav, SAMPLE_RATE, writeWav } from "./wav";
import { readAllSamples, type WaveForm } from "./waveform";

export { decodeMp3 } from "./mp3";
export { resample, Resampler } from "./resample";
export {
  decodeOpusWebm,
  encodeOpusWebm,
  encodeSpeechWebm,
  type OpusEncodeOptions,
} from "./opus";
export { readWav, SAMPLE_RATE, writeWav } from "./wav";
export { readAllSamples, type WaveForm } from "./waveform";

/** The audio formats this package reads. */
export type AudioFormat = "wav" | "webm" | "mp3";

/**
 * The format of audio starting with `head` (its first few bytes), from its
 * magic number, or undefined if it's none this package reads.
 */
export function sniffAudioFormat(head: Uint8Array): AudioFormat | undefined {
  const ascii = String.fromCharCode(...head.subarray(0, 4));
  if (ascii === "RIFF") return "wav";
  // EBML, the container WebM is a profile of.
  if (ascii === "\x1a\x45\xdf\xa3") return "webm";
  // An ID3 tag, or an MPEG audio frame sync.
  if (ascii.startsWith("ID3")) return "mp3";
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "mp3";
  return undefined;
}

/** The format of the audio file at `path`; see {@link sniffAudioFormat}. */
export async function audioFormatOf(path: string): Promise<AudioFormat> {
  const file = await open(path);
  try {
    const head = new Uint8Array(4);
    await file.read(head, 0, 4, 0);
    const format = sniffAudioFormat(head);
    if (!format) throw new Error(`${path} is not WAV, WebM or MP3 audio`);
    return format;
  } finally {
    await file.close();
  }
}

/**
 * `audio` as mono samples: a waveform as it is, a WAV file as it is (see
 * {@link readWav}), or a WebM/Opus or MP3 file decoded to 16 kHz.
 */
export async function ensureWaveForm(
  audio: string | WaveForm,
): Promise<WaveForm> {
  if (typeof audio !== "string") return audio;
  const format = await audioFormatOf(audio);
  if (format === "wav") return readWav(audio);
  const samples = await readAllSamples(decodedSamples(audio, format));
  return { samples, sampleRate: SAMPLE_RATE };
}

/**
 * Decodes the WebM/Opus or MP3 file at `src` to `dest` as 16 kHz mono 16-bit WAV.
 * Writes beside `dest` first, so an interrupted decode never leaves a partial file at `dest`.
 */
export async function decodeToWav(src: string, dest: string) {
  const format = await audioFormatOf(src);
  if (format === "wav") throw new Error(`${src} is already WAV`);
  await writeWav(decodedSamples(src, format), dest);
}

/** The file at `path`'s audio as 16 kHz mono samples. */
async function* decodedSamples(path: string, format: "webm" | "mp3") {
  if (format === "webm") yield* decodeOpusWebm(await readFile(path));
  else yield* decodeMp3(createReadStream(path));
}
