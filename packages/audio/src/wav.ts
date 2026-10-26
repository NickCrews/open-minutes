/// <reference path="./sherpa-onnx-node.d.ts" />
// Reading and writing WAV files, so packages that hand audio to this one don't
// need sherpa-onnx themselves.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sherpa_onnx, { type WaveForm } from "sherpa-onnx-node";
import { audioFormatOf, decodeToWav } from "@open-minutes/codecs";

export type { WaveForm };
export const readWave = sherpa_onnx.readWave;
export const writeWave = sherpa_onnx.writeWave;

/**
 * `audio` as a waveform. A path may be WAV, or WebM/Opus or MP3 as a site's
 * `downloadAudio` saves it, which is decoded to 16 kHz mono (via a
 * temporary WAV, removed afterwards). The format is read from the file's
 * bytes, not its name.
 */
export async function ensureWaveAudio(
  audio: string | WaveForm,
): Promise<WaveForm> {
  if (typeof audio !== "string") return audio;
  if ((await audioFormatOf(audio)) === "wav") return readWave(audio);
  const dir = await mkdtemp(join(tmpdir(), "open-minutes-wave-"));
  try {
    const wav = join(dir, "audio.wav");
    await decodeToWav(audio, wav);
    return readWave(wav);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
