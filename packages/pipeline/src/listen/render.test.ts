import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Image } from "./image";
import { melPosition, melSpectrogram, pitchTrack } from "./signal";

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

describe("melSpectrogram", () => {
  it("puts a tone's energy in the band at its frequency", () => {
    const bands = 64;
    const [col] = melSpectrogram(tone(1000, 1), RATE, [0.5], bands);
    const loudest = col!.indexOf(Math.max(...col!));
    expect(loudest / bands).toBeCloseTo(melPosition(1000), 1);
  });
});

describe("Image", () => {
  it("encodes a valid PNG of its pixels", () => {
    const img = new Image(3, 2, [255, 255, 255]);
    img.setPixel(1, 0, [10, 20, 30]);
    img.text(0, 0, "x", [0, 0, 0]); // clipped to the image, not an error
    const png = img.toPng();
    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(png.readUInt32BE(16)).toBe(3); // IHDR width
    expect(png.readUInt32BE(20)).toBe(2); // IHDR height
    const idatAt = png.indexOf("IDAT");
    const idat = png.subarray(
      idatAt + 4,
      idatAt + 4 + png.readUInt32BE(idatAt - 4),
    );
    const raw = inflateSync(idat);
    expect(raw.length).toBe((3 * 3 + 1) * 2);
    expect([...raw.subarray(0, 1)]).toEqual([0]); // filter byte
  });
});
