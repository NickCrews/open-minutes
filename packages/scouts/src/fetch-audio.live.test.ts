import { describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { akleg } from "@open-minutes/akleg";
import type { FetchAudio } from "@open-minutes/core/scout";
import { youtubeFetchAudio } from "@open-minutes/youtube";
import { encodeSpeech, probeDuration } from "./audio-tools";

// Each site's FetchAudio against the live site on one short recording, then
// the harness's encoding. Encoding needs ffmpeg, which CI's test job doesn't
// install; the ytdlp workflow does. Without it, only the download is checked.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

async function fetchAndEncode(
  fetchAudio: FetchAudio,
  externalId: string,
): Promise<{ bytes: number; encodedSecs: number | null }> {
  const dir = await mkdtemp(join(tmpdir(), "fetch-audio-"));
  try {
    const original = join(dir, "original");
    await fetchAudio(externalId, original, new AbortController().signal);
    const { size: bytes } = await stat(original);
    if (!hasFfmpeg) return { bytes, encodedSecs: null };
    const speech = join(dir, "speech.webm");
    await encodeSpeech(original, speech);
    return { bytes, encodedSecs: await probeDuration(speech) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("FetchAudio, live", () => {
  it("downloads an akleg.gov meeting's MP3", { timeout: 120_000 }, async () => {
    // A 7.5-minute meeting: a 3.6 MB MP3, 451.5 s by the API.
    const { bytes, encodedSecs } = await fetchAndEncode(
      akleg().fetchAudio,
      "HRES 2025-04-04 13:00:00",
    );
    expect(bytes).toBeGreaterThan(3_000_000);
    if (encodedSecs !== null) {
      expect(Math.abs(encodedSecs - 451.5)).toBeLessThan(1);
    }
  });

  it("downloads a YouTube video's audio", { tags: ["ytdlp"] }, async () => {
    // A 5 s video.
    const { bytes, encodedSecs } = await fetchAndEncode(
      youtubeFetchAudio(),
      "QUF1uLgzL-s",
    );
    expect(bytes).toBeGreaterThan(10_000);
    if (encodedSecs !== null) expect(encodedSecs).toBeCloseTo(5, 0);
  });
});
