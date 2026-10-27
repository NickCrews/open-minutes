import { describe, expect, it } from "vite-plus/test";
import {
  decodeOpusWebm,
  readAllSamples,
  SAMPLE_RATE,
} from "@open-minutes/codecs";
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

      const samples = await readAllSamples(decodeOpusWebm(video.speechWebm));
      expect(samples.length / SAMPLE_RATE).toBeCloseTo(5, 0);
    },
  );
});
