import { describe, expect, it } from "vitest";
import { medianPitch, pitchTrack } from "./signal";

const RATE = 16000;

/** `secs` of a sine at `hz` (with a quieter octave above, like a voice). */
function tone(hz: number, secs: number): Float32Array {
  return Float32Array.from(
    { length: secs * RATE },
    (_, i) =>
      0.5 * Math.sin((2 * Math.PI * hz * i) / RATE) +
      0.2 * Math.sin((4 * Math.PI * hz * i) / RATE),
  );
}

describe("pitchTrack", () => {
  it("finds the fundamental of a voiced tone", () => {
    for (const hz of [110, 220]) {
      const pitches = pitchTrack(tone(hz, 1), RATE, [0.2, 0.5, 0.8]);
      for (const p of pitches) expect(p).toBeCloseTo(hz, -0.5);
    }
  });

  it("calls silence unvoiced", () => {
    expect(pitchTrack(new Float32Array(RATE), RATE, [0.5])).toEqual([null]);
  });
});

describe("medianPitch", () => {
  it("measures only inside the speech runs", () => {
    const samples = new Float32Array(2 * RATE);
    samples.set(tone(150, 1), RATE);
    const all = [{ start: 0, end: 2 }];
    expect(medianPitch(samples, RATE, all, 0, 2).hz).toBeCloseTo(150, -0.5);
    const quiet = [{ start: 0, end: 0.9 }];
    expect(medianPitch(samples, RATE, quiet, 0, 2)).toEqual({
      hz: null,
      voicedSecs: 0,
    });
  });
});
