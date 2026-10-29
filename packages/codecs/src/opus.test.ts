import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeOpusWebm, encodeOpusWebm, encodeSpeechWebm } from "./opus";
import { readAllSamples } from "./waveform";

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

describe("decodeOpusWebm", () => {
  it("decodes to 16 kHz mono with both channels mixed in", async () => {
    const samples = await readAllSamples(decodeOpusWebm(readFileSync(TONES)));
    // Pre-skip and end padding trimmed: exactly 1.5 s, as ffmpeg decodes it.
    expect(samples.length).toBe(24_000);
    // ffmpeg's sine source is 1/8 full scale; a mono downmix halves each.
    expect(amplitude(samples, 440, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(samples, 1000, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(samples, 3000, 16_000)).toBeLessThan(0.001);
  });

  it("rejects a file with no Opus track", () => {
    expect(() =>
      decodeOpusWebm(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80])),
    ).toThrow("No Opus track");
  });
});

/** `samples` as an async iterable of `size`-sample chunks. */
async function* chunked(samples: Float32Array, size: number) {
  for (let i = 0; i < samples.length; i += size) {
    yield samples.subarray(i, i + size);
  }
}

describe("encodeOpusWebm", () => {
  it("writes WebM that decodes to the samples given, length included", async () => {
    const original = await readAllSamples(decodeOpusWebm(readFileSync(TONES)));
    // Chunks that don't line up with Opus frames.
    const webm = await encodeOpusWebm(chunked(original, 777), {
      bitrate: 24_000,
    });
    const decoded = await readAllSamples(decodeOpusWebm(webm));
    expect(decoded.length).toBe(original.length);
    expect(amplitude(decoded, 440, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(decoded, 1000, 16_000)).toBeCloseTo(0.0625, 2);
  });

  it("writes a file with no audio", async () => {
    const webm = await encodeOpusWebm(chunked(new Float32Array(0), 1), {
      bitrate: 24_000,
    });
    expect((await readAllSamples(decodeOpusWebm(webm))).length).toBe(0);
  });

  it("passes on an error from the samples", async () => {
    async function* failing() {
      yield new Float32Array(1000);
      throw new Error("download failed");
    }
    await expect(
      encodeOpusWebm(failing(), { bitrate: 24_000 }),
    ).rejects.toThrow("download failed");
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
