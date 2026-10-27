import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { decodeMp3, Resampler } from "./mp3";
import { readAllSamples } from "./waveform";

// 1.5 s of stereo MP3 at 24 kHz and 64 kbps, like akleg.gov's recordings:
// 440 Hz on the left, 1000 Hz on the right. Made with: ffmpeg -f lavfi -i
//   sine=frequency=440:duration=1.5 -f lavfi -i sine=frequency=1000:duration=1.5
//   -filter_complex amerge=inputs=2 -ar 24000 -c:a libmp3lame -b:a 64k tones.mp3
const TONES = new URL("./fixtures/tones.mp3", import.meta.url);

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

function sine(f: number, sampleRate: number, length: number) {
  return Float32Array.from({ length }, (_, i) =>
    Math.sin((2 * Math.PI * f * i) / sampleRate),
  );
}

describe("Resampler", () => {
  it("keeps what's below the new Nyquist and drops what's above", () => {
    const input = new Float32Array(24_000);
    const low = sine(1000, 24_000, 24_000);
    const high = sine(9000, 24_000, 24_000); // aliases to 7 kHz at 16 kHz
    for (let i = 0; i < input.length; i++) input[i] = low[i]! + high[i]!;
    const r = new Resampler(24_000, 16_000);
    const out = Float32Array.from([...r.push(input), ...r.flush()]);
    expect(out.length).toBe(16_000);
    const middle = out.subarray(1000, 15_000);
    expect(amplitude(middle, 1000, 16_000)).toBeCloseTo(1, 2);
    expect(amplitude(middle, 7000, 16_000)).toBeLessThan(0.01);
  });

  it("gives the same output however the input is split", () => {
    const input = sine(440, 24_000, 5_000);
    const whole = new Resampler(24_000, 16_000);
    const expected = [...whole.push(input), ...whole.flush()];
    const pieces = new Resampler(24_000, 16_000);
    const actual: number[] = [];
    for (let i = 0; i < input.length; i += 37) {
      actual.push(...pieces.push(input.subarray(i, i + 37)));
    }
    actual.push(...pieces.flush());
    expect(actual).toEqual(expected);
  });
});

describe("decodeMp3", () => {
  it("decodes to 16 kHz mono with both channels mixed in", async () => {
    const samples = await readAllSamples(decodeMp3(readFileSync(TONES)));
    // 1.5 s, give or take the encoder's padding.
    expect(samples.length / 16_000).toBeCloseTo(1.5, 1);
    // ffmpeg's sine source is 1/8 full scale; a mono downmix halves each.
    const middle = samples.subarray(2000, 22_000);
    expect(amplitude(middle, 440, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(middle, 1000, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(middle, 3000, 16_000)).toBeLessThan(0.001);
  });

  it("decodes a stream the same as a buffer", async () => {
    const bytes = readFileSync(TONES);
    async function* stream() {
      for (let i = 0; i < bytes.length; i += 1000) {
        yield bytes.subarray(i, i + 1000);
      }
    }
    expect(await readAllSamples(decodeMp3(stream()))).toEqual(
      await readAllSamples(decodeMp3(bytes)),
    );
  });

  it("rejects input with no MP3 audio", async () => {
    await expect(
      readAllSamples(decodeMp3(new Uint8Array(100))),
    ).rejects.toThrow();
  });
});
