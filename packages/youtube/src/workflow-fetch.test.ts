import { describe, expect, it } from "vite-plus/test";
import {
  decodeOpusWebm,
  readAllSamples,
  SAMPLE_RATE,
} from "@open-minutes/codecs";
import { metadataFromJson } from "./core";
import { fetchVideoViaWorkflow } from "./workflow-fetch";

// Runs the real fetch-youtube-audio workflow, so it needs a token allowed to
// run it. In a pull request's CI it runs the pull request's version of the
// workflow, else main's.
const token = process.env.YOUTUBE_AUDIO_DISPATCH_TOKEN;

describe("fetchVideoViaWorkflow", () => {
  it.skipIf(!token)(
    "gets a video's metadata and speech audio from a workflow run",
    // A run takes 2-6 minutes, plus any queue.
    { tags: ["slow"], timeout: 20 * 60_000 },
    async () => {
      // A 5 s video.
      const video = await fetchVideoViaWorkflow("QUF1uLgzL-s", token!);

      expect(metadataFromJson(video.metadataJson).id).toBe("QUF1uLgzL-s");

      const samples = await readAllSamples(decodeOpusWebm(video.speechWebm));
      expect(samples.length / SAMPLE_RATE).toBeCloseTo(5, 0);
    },
  );
});
