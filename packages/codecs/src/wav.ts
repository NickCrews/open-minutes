import { readFile } from "node:fs/promises";

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

/** A canonical 44-byte header for `samples` of 16-bit mono PCM at 16 kHz. */
export function wavHeader(samples: number): Uint8Array {
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

/**
 * The sample rate and samples of a WAV written by this package (canonical
 * 44-byte header, 16-bit mono). For tests, so this package needn't depend on
 * `@open-minutes/audio/wav`, which depends on it.
 */
export async function readCanonicalWav(path: string) {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  const canonical =
    bytes.length >= 44 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 16) === "WAVEfmt " &&
    view.getUint32(16, true) === 16 && // fmt chunk size
    view.getUint16(20, true) === 1 && // PCM
    view.getUint16(22, true) === 1 && // mono
    view.getUint16(34, true) === 16 && // bits per sample
    ascii(36, 40) === "data" &&
    view.getUint32(40, true) === bytes.length - 44;
  if (!canonical) {
    throw new Error(`${path} is not a canonical 16-bit mono PCM WAV`);
  }
  const pcm = new Int16Array(
    bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length),
  );
  return {
    sampleRate: view.getUint32(24, true),
    samples: Float32Array.from(pcm, (s) => s / 32768),
  };
}
