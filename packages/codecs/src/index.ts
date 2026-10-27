import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { mp3ToWav } from "./mp3";
import { webmOpusToWav } from "./opus";

export { mp3ToWav, Resampler } from "./mp3";
export {
  decodeOpusWebm,
  encodeOpusWebm,
  encodeSpeechWebm,
  type OpusEncodeOptions,
  webmOpusToWav,
} from "./opus";
export { SAMPLE_RATE } from "./wav";

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
 * Decodes the WebM/Opus or MP3 file at `src` to `dest` as 16 kHz mono 16-bit
 * WAV. The format is read from the file's bytes, not its name.
 */
export async function decodeToWav(src: string, dest: string) {
  const format = await audioFormatOf(src);
  switch (format) {
    case "webm":
      return webmOpusToWav(await readFile(src), dest);
    case "mp3":
      return mp3ToWav(createReadStream(src), dest);
    case "wav":
      throw new Error(`${src} is already WAV`);
  }
}
