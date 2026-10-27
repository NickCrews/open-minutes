import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeSpeechWebm,
  OpusReader,
  OpusWriter,
  webmOpusToWav,
} from "./opus";
import { readCanonicalWav } from "./wav";

// 1.5 s of stereo Opus in WebM: 440 Hz on the left, 1000 Hz on the right.
// Made with: ffmpeg -f lavfi -i sine=frequency=440:duration=1.5 -f lavfi -i
//   sine=frequency=1000:duration=1.5 -filter_complex amerge=inputs=2
//   -c:a libopus -b:a 64k tones.webm
const TONES = new URL("./fixtures/tones.webm", import.meta.url);

/** The amplitude of frequency `f` in `x` (Goertzel). */
function amplitude(x: Float32Array, f: number, sampleRate: number) {
  const c = 2 * Math.cos((2 * Math.PI * f) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s = v + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / x.length;
}

describe("webmOpusToWav", () => {
  const dest = join(mkdtempSync(join(tmpdir(), "opus-")), "tones.wav");

  it("decodes to 16 kHz mono with both channels mixed in", async () => {
    await webmOpusToWav(readFileSync(TONES), dest);
    const wave = await readCanonicalWav(dest);
    expect(wave.sampleRate).toBe(16_000);
    // Pre-skip and end padding trimmed: exactly 1.5 s, as ffmpeg decodes it.
    expect(wave.samples.length).toBe(24_000);
    // ffmpeg's sine source is 1/8 full scale; a mono downmix halves each.
    expect(amplitude(wave.samples, 440, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(wave.samples, 1000, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(wave.samples, 3000, 16_000)).toBeLessThan(0.001);
  });

  // WebAssembly is deterministic, so the output is byte-for-byte the same on
  // every machine. This pins it, so a decoder upgrade that changes the audio
  // (and with it the golden fixtures' _audio_sha256) shows up here first.
  it("gives the same bytes on every run", async () => {
    await webmOpusToWav(readFileSync(TONES), dest);
    const sha256 = createHash("sha256")
      .update(readFileSync(dest))
      .digest("hex");
    expect(sha256).toMatchInlineSnapshot(
      `"2dcf2ef6678365d9a540b8a194ef5f71ea877edcb45699062f95cad8019914f1"`,
    );
  });

  it("rejects a file with no Opus track", async () => {
    await expect(
      webmOpusToWav(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80]), dest),
    ).rejects.toThrow("No Opus track");
  });
});

/** All of `reader`'s samples, end to end. */
async function readAll(reader: OpusReader): Promise<Float32Array> {
  const chunks: Float32Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

describe("OpusReader", () => {
  it("reads the same samples webmOpusToWav writes", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "opus-")), "tones.wav");
    await webmOpusToWav(readFileSync(TONES), dest);
    const wave = await readCanonicalWav(dest);
    const samples = await readAll(new OpusReader(readFileSync(TONES)));
    // The WAV is 16-bit, so compare at that precision.
    expect(samples.length).toBe(wave.samples.length);
    expect(
      samples.every((s, i) => Math.abs(s - wave.samples[i]!) <= 1 / 32768),
    ).toBe(true);
  });
});

describe("OpusWriter", () => {
  it("writes WebM that decodes to the samples written, length included", async () => {
    const original = await readAll(new OpusReader(readFileSync(TONES)));
    const writer = new OpusWriter({ bitrate: 24_000 });
    // Chunks that don't line up with Opus frames.
    for (let i = 0; i < original.length; i += 777) {
      writer.write(original.subarray(i, i + 777));
    }
    const decoded = await readAll(new OpusReader(writer.end()));
    expect(decoded.length).toBe(original.length);
    expect(amplitude(decoded, 440, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(decoded, 1000, 16_000)).toBeCloseTo(0.0625, 2);
  });

  it("writes a file with no audio", async () => {
    const decoded = await readAll(
      new OpusReader(new OpusWriter({ bitrate: 24_000 }).end()),
    );
    expect(decoded.length).toBe(0);
  });

  it("can't be written to after it ends", () => {
    const writer = new OpusWriter({ bitrate: 24_000 });
    writer.end();
    expect(() => writer.write(new Float32Array(10))).toThrow("already ended");
  });
});

describe("encodeSpeechWebm", () => {
  // Like the decoder, the encoder is WebAssembly, so its output is pinned.
  it("gives the same bytes on every run", async () => {
    const webm = await encodeSpeechWebm(readFileSync(TONES));
    expect(
      createHash("sha256").update(webm).digest("hex"),
    ).toMatchInlineSnapshot(
      `"aba3c83c05b16be7dc839545a5df7d474f97eabd7780a90769738b7fd4c6bc8f"`,
    );
  });
});
