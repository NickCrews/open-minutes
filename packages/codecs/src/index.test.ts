import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { audioFormatOf, decodeToWav, mp3ToWav, webmOpusToWav } from ".";

const TONES_WEBM = fileURLToPath(
  new URL("./fixtures/tones.webm", import.meta.url),
);
const TONES_MP3 = fileURLToPath(
  new URL("./fixtures/tones.mp3", import.meta.url),
);

describe("audioFormatOf", () => {
  it("reads the format from the file's bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codecs-"));
    const wav = join(dir, "tones.wav");
    await webmOpusToWav(readFileSync(TONES_WEBM), wav);
    expect(await audioFormatOf(TONES_WEBM)).toBe("webm");
    expect(await audioFormatOf(TONES_MP3)).toBe("mp3");
    expect(await audioFormatOf(wav)).toBe("wav");
  });
});

describe("decodeToWav", () => {
  it.each([
    { name: "WebM/Opus", src: TONES_WEBM, decode: webmOpusToWav },
    { name: "MP3", src: TONES_MP3, decode: mp3ToWav },
  ])("decodes $name as its own decoder does", async ({ src, decode }) => {
    const dir = mkdtempSync(join(tmpdir(), "codecs-"));
    await decodeToWav(src, join(dir, "a.wav"));
    await decode(readFileSync(src), join(dir, "b.wav"));
    expect(readFileSync(join(dir, "a.wav"))).toEqual(
      readFileSync(join(dir, "b.wav")),
    );
  });
});
