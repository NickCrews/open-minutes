import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWave } from "@open-minutes/audio/wav";
import { mp3ToWav, Resampler } from "./mp3";

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

describe("mp3ToWav", () => {
  const dest = join(mkdtempSync(join(tmpdir(), "mp3-")), "tones.wav");

  it("decodes to 16 kHz mono with both channels mixed in", async () => {
    await mp3ToWav(readFileSync(TONES), dest);
    const wave = readWave(dest);
    expect(wave.sampleRate).toBe(16_000);
    // 1.5 s, give or take the encoder's padding.
    expect(wave.samples.length / 16_000).toBeCloseTo(1.5, 1);
    // ffmpeg's sine source is 1/8 full scale; a mono downmix halves each.
    const middle = wave.samples.subarray(2000, 22_000);
    expect(amplitude(middle, 440, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(middle, 1000, 16_000)).toBeCloseTo(0.0625, 2);
    expect(amplitude(middle, 3000, 16_000)).toBeLessThan(0.001);
  });

  it("decodes a stream the same as a buffer", async () => {
    await mp3ToWav(readFileSync(TONES), dest);
    const whole = readFileSync(dest);
    const bytes = readFileSync(TONES);
    async function* stream() {
      for (let i = 0; i < bytes.length; i += 1000) {
        yield bytes.subarray(i, i + 1000);
      }
    }
    await mp3ToWav(stream(), dest);
    expect(readFileSync(dest).equals(whole)).toBe(true);
  });

  // WebAssembly is deterministic, so the output is byte-for-byte the same on
  // every machine. This pins it, so a decoder upgrade that changes the audio
  // shows up here first.
  it("gives the same bytes on every run", async () => {
    await mp3ToWav(readFileSync(TONES), dest);
    const sha256 = createHash("sha256")
      .update(readFileSync(dest))
      .digest("hex");
    expect(sha256).toMatchInlineSnapshot(
      `"c467dc85a021dda6d6c7509410d114929861e444b4255b727df0ad2ec484a167"`,
    );
  });

  it("rejects input with no MP3 audio", async () => {
    await expect(mp3ToWav(new Uint8Array(100), dest)).rejects.toThrow();
  });
});
