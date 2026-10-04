import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWave } from "@open-minutes/audio/wav";
import { akleg, legislatureOf } from "./index";

// Against the live akleg.gov, so a change to its API or media server fails
// here, in CI, rather than in an ingest. index.test.ts covers the parsing
// offline; these check the API still answers the way its fixtures say. They
// use past meetings, whose records shouldn't change, so a failure means
// akleg.gov changed (or is down), not the data. ~10 s in all.
describe("akleg.gov, live", () => {
  const source = akleg();

  it("lists a committee's meetings and their recordings", async () => {
    const meetings = await source.meetingsOfCommittee("HRES", 30);
    expect(meetings.length).toBeGreaterThanOrEqual(100);
    expect(meetings.find((m) => m.id === "HRES 2018-09-10 14:00:00")).toEqual({
      id: "HRES 2018-09-10 14:00:00",
      committee: "House RESOURCES",
      location: "Anch LIO AUDITORIUM",
      date: "2018-09-10",
      time: "14:00:00",
      cancelled: false,
      audio: [
        {
          url: "https://www.akleg.gov/ftr/2018/20180910/sres/sres_1400.mp3",
          durationSecs: 10746.5,
        },
      ],
      video: [
        {
          url: "https://www.akleg.gov/video/2018/20180910/jres/jres_1400.m4v",
          durationSecs: 11229.833,
        },
      ],
    });
  });

  it("lists the current Legislature's meetings", async () => {
    // Early in a new Legislature this may be empty; it must still parse.
    const year = new Date().getFullYear();
    await expect(
      source.meetingsOfCommittee("HRES", legislatureOf(year)),
    ).resolves.toBeInstanceOf(Array);
  });

  it("gets a meeting whose code has an ampersand", async () => {
    const metadata = await source.getMetadata("SL&C 2017-03-07 13:30:00");
    expect(metadata).toMatchObject({
      channelId: "SL&C",
      title: "Senate LABOR & COMMERCE - 2017-03-07 13:30:00",
    });
  });

  it(
    "downloads and decodes a meeting's audio",
    { timeout: 120_000 },
    async () => {
      // A 7.5-minute meeting: a 3.6 MB MP3.
      const path = join(mkdtempSync(join(tmpdir(), "akleg-")), "audio.wav");
      const result = await source.ensureAudioDownloaded(
        "HRES 2025-04-04 13:00:00",
        path,
      );
      expect(result).toEqual({ downloaded: true });
      const wave = readWave(path);
      expect(wave.sampleRate).toBe(16_000);
      // The API says 451.508 s; the decoded MP3 is about half a second shorter.
      expect(Math.abs(wave.samples.length / 16_000 - 451.5)).toBeLessThan(1);
    },
  );
});
