import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCanonicalWav, toInt16, wavHeader } from "./wav";

const dir = mkdtempSync(join(tmpdir(), "wav-"));

/** A WAV of `samples` as this package writes it, after `edit` to its bytes. */
function writeWav(
  samples: number[],
  edit: (bytes: Uint8Array, view: DataView) => void = () => {},
) {
  const pcm = toInt16(Float32Array.from(samples));
  const bytes = new Uint8Array(44 + pcm.length);
  bytes.set(wavHeader(samples.length));
  bytes.set(pcm, 44);
  edit(bytes, new DataView(bytes.buffer));
  const path = join(dir, `${Math.random()}.wav`);
  writeFileSync(path, bytes);
  return path;
}

describe("readCanonicalWav", () => {
  it("reads the sample rate and samples", async () => {
    const wave = await readCanonicalWav(writeWav([0, 0.5, -0.5, -1]));
    expect(wave.sampleRate).toBe(16_000);
    expect(Array.from(wave.samples)).toEqual([0, 0.5, -0.5, -1]);
  });

  it.each([
    {
      name: "stereo",
      edit: (_: Uint8Array, view: DataView) => view.setUint16(22, 2, true),
    },
    {
      name: "8-bit",
      edit: (_: Uint8Array, view: DataView) => view.setUint16(34, 8, true),
    },
    {
      name: "not PCM (IEEE float)",
      edit: (_: Uint8Array, view: DataView) => view.setUint16(20, 3, true),
    },
    {
      name: "not RIFF",
      edit: (bytes: Uint8Array) => bytes.set([0x52, 0x49, 0x46, 0x58]),
    },
    {
      name: "a data length that doesn't match the file",
      edit: (_: Uint8Array, view: DataView) => view.setUint32(40, 2, true),
    },
  ])("rejects a WAV that is $name", async ({ edit }) => {
    await expect(readCanonicalWav(writeWav([0, 0.5], edit))).rejects.toThrow(
      "not a canonical 16-bit mono PCM WAV",
    );
  });

  it("rejects a file shorter than the header", async () => {
    const path = join(dir, "short.wav");
    writeFileSync(path, wavHeader(0).subarray(0, 20));
    await expect(readCanonicalWav(path)).rejects.toThrow(
      "not a canonical 16-bit mono PCM WAV",
    );
  });
});
