import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isModelWav, readCanonicalWav, wavMetadata, writeWav } from "./wav";

const dir = mkdtempSync(join(tmpdir(), "wav-"));

async function* chunks(...chunks: number[][]) {
  for (const chunk of chunks) yield Float32Array.from(chunk);
}

/** A WAV of `samples` as {@link writeWav} writes it, after `edit` to its bytes. */
async function wavOf(
  samples: number[],
  edit: (bytes: Uint8Array, view: DataView) => void = () => {},
) {
  const path = join(dir, `${Math.random()}.wav`);
  await writeWav(chunks(samples), path);
  const bytes = readFileSync(path);
  edit(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  writeFileSync(path, bytes);
  return path;
}

describe("writeWav", () => {
  it("writes a 44-byte header for 16 kHz mono 16-bit PCM", async () => {
    const bytes = readFileSync(await wavOf([0, 0.5, -0.5]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.length).toBe(44 + 6);
    expect(view.getUint32(4, true)).toBe(36 + 6); // RIFF chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6); // data bytes
  });

  it("writes samples from every chunk", async () => {
    const path = join(dir, "chunks.wav");
    await writeWav(chunks([0, 0.5], [], [-0.5, -1]), path);
    const wave = await readCanonicalWav(path);
    expect(Array.from(wave.samples)).toEqual([0, 0.5, -0.5, -1]);
  });
});

describe("isModelWav", () => {
  it("accepts the default metadata", () => {
    expect(isModelWav(wavMetadata())).toBe(true);
  });

  it.each([
    { channels: 2 },
    { sampleRate: 48_000 },
    { bitsPerSample: 24 },
    { audioFormat: "float" as const },
  ])("rejects %o", (overrides) => {
    expect(isModelWav(wavMetadata(overrides))).toBe(false);
  });
});

describe("readCanonicalWav", () => {
  it("reads the metadata and samples", async () => {
    const wave = await readCanonicalWav(await wavOf([0, 0.5, -0.5, -1]));
    expect(wave).toEqual({
      ...wavMetadata(),
      samples: Float32Array.from([0, 0.5, -0.5, -1]),
    });
  });

  it.each([
    {
      name: "stereo",
      edit: (_: Uint8Array, view: DataView) => view.setUint16(22, 2, true),
    },
    {
      name: "44.1 kHz",
      edit: (_: Uint8Array, view: DataView) => view.setUint32(24, 44_100, true),
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
      name: "a-law, a format code this package doesn't read",
      edit: (_: Uint8Array, view: DataView) => view.setUint16(20, 6, true),
    },
    {
      name: "not RIFF",
      edit: (bytes: Uint8Array) => bytes.set([0x52, 0x49, 0x46, 0x58]),
    },
    {
      name: "one with an 18-byte fmt chunk",
      edit: (_: Uint8Array, view: DataView) => view.setUint32(16, 18, true),
    },
    {
      name: "a data length that doesn't match the file",
      edit: (_: Uint8Array, view: DataView) => view.setUint32(40, 2, true),
    },
  ])("rejects a WAV that is $name", async ({ edit }) => {
    await expect(readCanonicalWav(await wavOf([0, 0.5], edit))).rejects.toThrow(
      "not a canonical 16 kHz 16-bit mono PCM WAV",
    );
  });

  it("rejects a file shorter than the header", async () => {
    const path = join(dir, "short.wav");
    writeFileSync(path, readFileSync(await wavOf([])).subarray(0, 20));
    await expect(readCanonicalWav(path)).rejects.toThrow(
      "not a canonical 16 kHz 16-bit mono PCM WAV",
    );
  });
});
