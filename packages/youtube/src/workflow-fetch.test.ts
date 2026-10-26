import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeToWav, SAMPLE_RATE } from "@open-minutes/codecs";
import { fetchVideoViaWorkflow } from "./workflow-fetch";

// Runs the real fetch-youtube-audio workflow on main, so it needs a token
// allowed to run it, and tests main's version of the workflow.
const token = process.env.YOUTUBE_AUDIO_DISPATCH_TOKEN;

describe("fetchVideoViaWorkflow", () => {
  it.skipIf(!token)(
    "gets a video's metadata and speech audio from a workflow run",
    // A run takes 2-6 minutes, plus any queue.
    { tags: ["slow"], timeout: 20 * 60_000 },
    async () => {
      // A 5 s video.
      const video = await fetchVideoViaWorkflow("QUF1uLgzL-s", token!);

      const info = JSON.parse(new TextDecoder().decode(video.infoJson));
      expect(info.id).toBe("QUF1uLgzL-s");
      // The stream URLs are dropped.
      expect(info.formats).toBeUndefined();

      const dir = await mkdtemp(join(tmpdir(), "fetch-youtube-audio-"));
      try {
        const webmPath = join(dir, "speech.webm");
        const wavPath = join(dir, "speech.wav");
        await writeFile(webmPath, video.speechWebm);
        await decodeToWav(webmPath, wavPath);
        // A 44-byte header and 16-bit mono samples.
        const { size } = await stat(wavPath);
        expect((size - 44) / 2 / SAMPLE_RATE).toBeCloseTo(5, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
