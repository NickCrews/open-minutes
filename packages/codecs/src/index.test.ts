import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  audioFormatOf,
  decodeMp3,
  decodeOpusWebm,
  decodeToWav,
  ensureWaveForm,
  readAllSamples,
  readWav,
} from ".";

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
    await decodeToWav(TONES_WEBM, wav);
    expect(await audioFormatOf(TONES_WEBM)).toBe("webm");
    expect(await audioFormatOf(TONES_MP3)).toBe("mp3");
    expect(await audioFormatOf(wav)).toBe("wav");
  });
});

describe("decodeToWav", () => {
  it.each([
    {
      name: "WebM/Opus",
      src: TONES_WEBM,
      decode: () => decodeOpusWebm(readFileSync(TONES_WEBM)),
    },
    {
      name: "MP3",
      src: TONES_MP3,
      decode: () => decodeMp3(createReadStream(TONES_MP3)),
    },
  ])("writes $name's samples as 16-bit WAV", async ({ src, decode }) => {
    const wav = join(mkdtempSync(join(tmpdir(), "codecs-")), "a.wav");
    await decodeToWav(src, wav);
    const written = await readWav(wav);
    const samples = await readAllSamples(decode());
    expect(written.sampleRate).toBe(16_000);
    expect(written.samples.length).toBe(samples.length);
    expect(
      samples.every((s, i) => Math.abs(s - written.samples[i]!) <= 1 / 32768),
    ).toBe(true);
  });

  // WebAssembly is deterministic, so the output is byte-for-byte the same on
  // every machine. This pins it, so a decoder upgrade that changes the audio
  // (and with it the golden fixtures' _audio_sha256) shows up here first.
  it.each([
    {
      name: "WebM/Opus",
      src: TONES_WEBM,
      sha256:
        "2dcf2ef6678365d9a540b8a194ef5f71ea877edcb45699062f95cad8019914f1",
    },
    {
      name: "MP3",
      src: TONES_MP3,
      sha256:
        "c467dc85a021dda6d6c7509410d114929861e444b4255b727df0ad2ec484a167",
    },
  ])("gives the same bytes for $name on every run", async ({ src, sha256 }) => {
    const wav = join(mkdtempSync(join(tmpdir(), "codecs-")), "a.wav");
    await decodeToWav(src, wav);
    expect(createHash("sha256").update(readFileSync(wav)).digest("hex")).toBe(
      sha256,
    );
  });

  it("rejects a WAV", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codecs-"));
    await decodeToWav(TONES_WEBM, join(dir, "a.wav"));
    await expect(
      decodeToWav(join(dir, "a.wav"), join(dir, "b.wav")),
    ).rejects.toThrow("is already WAV");
  });
});

describe("ensureWaveForm", () => {
  it.each([
    {
      name: "WebM/Opus",
      src: TONES_WEBM,
      decode: () => decodeOpusWebm(readFileSync(TONES_WEBM)),
    },
    {
      name: "MP3",
      src: TONES_MP3,
      decode: () => decodeMp3(createReadStream(TONES_MP3)),
    },
  ])("decodes $name as its own decoder does", async ({ src, decode }) => {
    expect(await ensureWaveForm(src)).toEqual({
      samples: await readAllSamples(decode()),
      sampleRate: 16_000,
    });
  });

  it("reads a WAV as it is", async () => {
    const wav = join(mkdtempSync(join(tmpdir(), "codecs-")), "tones.wav");
    await decodeToWav(TONES_WEBM, wav);
    expect(await ensureWaveForm(wav)).toEqual(await readWav(wav));
  });

  it("returns a waveform as it is", async () => {
    const wave = { samples: Float32Array.from([0.5]), sampleRate: 8_000 };
    expect(await ensureWaveForm(wave)).toBe(wave);
  });

  it("rejects a file in no format it reads", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "codecs-")), "a.txt");
    writeFileSync(path, "not audio");
    await expect(ensureWaveForm(path)).rejects.toThrow(
      "is not WAV, WebM or MP3 audio",
    );
  });
});
