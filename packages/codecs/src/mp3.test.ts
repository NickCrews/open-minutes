import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { decodeMp3 } from "./mp3";
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
