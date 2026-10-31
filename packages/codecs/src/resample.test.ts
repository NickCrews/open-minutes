import { describe, expect, it } from "vite-plus/test";
import { resample, Resampler } from "./resample";

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

describe("resample", () => {
  it("gives what a Resampler gives, at the new rate", () => {
    const samples = sine(440, 24_000, 5_000);
    const r = new Resampler(24_000, 16_000);
    expect(resample({ samples, sampleRate: 24_000 }, 16_000)).toEqual({
      samples: Float32Array.from([...r.push(samples), ...r.flush()]),
      sampleRate: 16_000,
    });
  });

  it("returns a wave already at the rate as it is", () => {
    const wave = { samples: sine(440, 16_000, 100), sampleRate: 16_000 };
    expect(resample(wave, 16_000)).toBe(wave);
  });
});
