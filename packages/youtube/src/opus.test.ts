import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWave } from "@open-minutes/audio/wav";
import { webmOpusToWav } from "./opus";

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
    const wave = readWave(dest);
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
