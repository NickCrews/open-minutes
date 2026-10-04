import { describe, expect, it } from "vitest";
import type { WaveForm } from "@open-minutes/audio/wav";
import { medianPitch, pitchAt } from "./pitch";

const RATE = 16000;

/** `secs` of audio from `sample(t)`, t in seconds. */
function wave(secs: number, sample: (t: number) => number): WaveForm {
  const samples = new Float32Array(Math.round(secs * RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = sample(i / RATE);
  return { samples, sampleRate: RATE };
}

const sine = (hz: number) => (t: number) =>
  0.3 * Math.sin(2 * Math.PI * hz * t);

/** A voice-like tone: a fundamental and weaker harmonics. */
const voiced = (hz: number) => (t: number) =>
  [1, 0.8, 0.6, 0.4, 0.3].reduce(
    (sum, amp, k) => sum + 0.1 * amp * Math.sin(2 * Math.PI * hz * (k + 1) * t),
    0,
  );

/** Deterministic white noise. */
function noise() {
  let seed = 7;
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return 0.3 * (seed / 2 ** 31 - 0.5);
  };
}

describe("pitchAt", () => {
  it.each([80, 110, 165, 220, 330])("finds a %d Hz sine", (hz) => {
    expect(pitchAt(wave(0.5, sine(hz)), 0.1)).toBeCloseTo(hz, 0);
  });

  it.each([100, 120, 210])(
    "finds the fundamental of a %d Hz tone with harmonics, not a harmonic",
    (hz) => {
      expect(pitchAt(wave(0.5, voiced(hz)), 0.1)).toBeCloseTo(hz, 0);
    },
  );

  it("finds a low voice with a missing fundamental by its period", () => {
    // Harmonics 2-4 of 100 Hz, as a telephone line leaves a low voice.
    const tone = (t: number) =>
      [2, 3, 4].reduce(
        (s, k) => s + 0.1 * Math.sin(2 * Math.PI * 100 * k * t),
        0,
      );
    expect(pitchAt(wave(0.5, tone), 0.1)).toBeCloseTo(100, 0);
  });

  it("finds a low voice under a stronger second harmonic, not double it", () => {
    // Half a period on, the strong 240 Hz harmonic almost repeats: plain YIN
    // takes that for the period, an octave too high.
    const tone = (t: number) =>
      0.05 * Math.sin(2 * Math.PI * 120 * t) +
      0.3 * Math.sin(2 * Math.PI * 240 * t + 1);
    expect(pitchAt(wave(0.5, tone), 0.1)).toBeCloseTo(120, 0);
  });

  it("hears no pitch in silence or noise", () => {
    expect(
      pitchAt(
        wave(0.5, () => 0),
        0.1,
      ),
    ).toBeNull();
    expect(pitchAt(wave(0.5, noise()), 0.1)).toBeNull();
  });

  it("hears no pitch outside the range of speech", () => {
    expect(pitchAt(wave(0.5, sine(1000)), 0.1)).toBeNull();
  });

  it("is null for a frame running past the audio", () => {
    expect(pitchAt(wave(0.5, sine(100)), 0.45)).toBeNull();
    expect(pitchAt(wave(0.5, sine(100)), -0.1)).toBeNull();
  });
});

describe("medianPitch", () => {
  // A low voice for a second, then a high one.
  const twoVoices = wave(2, (t) => (t < 1 ? voiced(110)(t) : voiced(220)(t)));

  it("is the median over the speech in a range", () => {
    expect(medianPitch(twoVoices, [{ start: 0, end: 2 }], 0, 0.9)).toBeCloseTo(
      110,
      -1,
    );
    expect(medianPitch(twoVoices, [{ start: 0, end: 2 }], 1.1, 2)).toBeCloseTo(
      220,
      -1,
    );
  });

  it("only measures inside the speech spans", () => {
    expect(
      medianPitch(twoVoices, [{ start: 1.2, end: 1.8 }], 0, 2),
    ).toBeCloseTo(220, -1);
  });

  it("is null with too little voiced speech", () => {
    expect(medianPitch(twoVoices, [{ start: 0, end: 0.1 }], 0, 2)).toBeNull();
    expect(medianPitch(twoVoices, [], 0, 2)).toBeNull();
    expect(
      medianPitch(wave(1, noise()), [{ start: 0, end: 1 }], 0, 1),
    ).toBeNull();
  });
});
