import { describe, expect, it } from "vite-plus/test";
import type {
  RecordingKey,
  Scout,
  ScoutContext,
  ScoutedRecording,
} from "@open-minutes/core/scout";
import { runLogger } from "../logger";
import { SCOUTS } from ".";

// Each scout end to end against its live site, with only `unseen` faked: it
// passes through just the recordings a test names, so a scan reads one
// recording's metadata rather than a whole channel's.

function scout(id: string): Scout {
  return SCOUTS.find((s) => s.id === id)!;
}

async function scanFor(
  scout: Scout,
  wanted: string[],
  now = new Date(),
): Promise<{
  reports: ScoutedRecording[];
  offered: RecordingKey[];
  errors: number;
}> {
  const offered: RecordingKey[] = [];
  const logger = runLogger({ sink: () => {}, annotate: false });
  const ctx: ScoutContext = {
    unseen: async (keys) => {
      offered.push(...keys);
      return keys.filter((k) => wanted.includes(k.external_id));
    },
    logger: logger.child(scout.id),
    signal: new AbortController().signal,
    now,
  };
  const reports: ScoutedRecording[] = [];
  for await (const r of scout.scan(ctx)) reports.push(r);
  return { reports, offered, errors: logger.errors };
}

describe("the akleg scout, live", { timeout: 120_000 }, () => {
  it("reports a past House Resources meeting", async () => {
    // In the 30th Legislature, 2017-2018.
    const { reports, offered, errors } = await scanFor(
      scout("akleg"),
      ["HRES 2018-09-10 14:00:00"],
      new Date("2018-12-01T00:00:00Z"),
    );
    expect(errors).toBe(0);
    expect(offered.length).toBeGreaterThanOrEqual(100);
    expect(reports).toEqual([
      {
        site: "akleg",
        external_id: "HRES 2018-09-10 14:00:00",
        permalink:
          "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
        title: "House RESOURCES - 2018-09-10 14:00:00",
        description: "Anch LIO AUDITORIUM",
        published_at: null,
        duration_secs: 10746.5,
        is_meeting: true,
        notes: "",
        bodies: ["hres"],
      },
    ]);
  });
});

describe("the YouTube scouts, live", { tags: ["ytdlp"] }, () => {
  it("reports a GBOS meeting", async () => {
    const { reports, offered, errors } = await scanFor(scout("gbos-youtube"), [
      "9HoIM5INxpI",
    ]);
    expect(errors).toBe(0);
    expect(offered.length).toBeGreaterThan(10);
    expect(reports).toEqual([
      {
        site: "youtube",
        external_id: "9HoIM5INxpI",
        permalink: "https://www.youtube.com/watch?v=9HoIM5INxpI",
        title: "Girdwood Board of Supervisors Regular Meeting March 23, 2026",
        description: expect.stringContaining("www.muni.org/gbos"),
        // An upload, not a stream: yt-dlp's `timestamp`.
        published_at: new Date("2026-03-24T19:05:28Z"),
        duration_secs: 9970,
        is_meeting: null,
        notes: "",
        bodies: [],
      },
    ]);
  });

  it("lists the MOA channel's videos", async () => {
    const { offered } = await scanFor(scout("moa-youtube"), []);
    expect(offered.length).toBeGreaterThan(1000);
  });
});
