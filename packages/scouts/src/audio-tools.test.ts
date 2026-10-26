import { describe, expect, it } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeSpeech, probeDuration } from "./audio-tools";

// Needs ffmpeg, which CI's test job doesn't install; the ytdlp workflow does.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../codecs/src/fixtures/${name}`, import.meta.url));

describe.skipIf(!hasFfmpeg)("encodeSpeech", () => {
  it.each(["tones.mp3", "tones.webm"])(
    "encodes %s as 16 kHz mono Opus in WebM, keeping its length",
    async (name) => {
      const dir = await mkdtemp(join(tmpdir(), "encode-"));
      try {
        const out = join(dir, "speech.webm");
        await encodeSpeech(fixture(name), out);
        const stream = JSON.parse(
          execFileSync("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,sample_rate,channels:format=format_name",
            "-of",
            "json",
            out,
          ]).toString(),
        );
        // Opus always reports 48 kHz; libopus took 16 kHz in.
        expect(stream.streams[0]).toMatchObject({
          codec_name: "opus",
          channels: 1,
        });
        expect(stream.format.format_name).toContain("webm");
        expect(
          Math.abs(
            (await probeDuration(out)) - (await probeDuration(fixture(name))),
          ),
        ).toBeLessThan(0.1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
