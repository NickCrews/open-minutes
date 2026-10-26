import { describe, expect, it } from "vite-plus/test";
import type { AkLeg, AkLegMeeting } from "@open-minutes/akleg";
import type { ScoutedRecording } from "@open-minutes/core/scout";
import { runLogger } from "../logger";
import { aklegScout } from "./akleg";

function meeting(id: string, fields: Partial<AkLegMeeting> = {}): AkLegMeeting {
  const [, date, time] = id.split(" ");
  return {
    id,
    committee: "House RESOURCES",
    location: "Capitol 124",
    date: date!,
    time: time!,
    cancelled: false,
    audio: [{ url: "https://www.akleg.gov/ftr/x.mp3", durationSecs: 600 }],
    video: [],
    ...fields,
  };
}

async function scan(meetings: AkLegMeeting[], now: Date) {
  const asked: [string, number][] = [];
  const client = {
    meetingsOfCommittee: async (committee: string, legislature: number) => {
      asked.push([committee, legislature]);
      return meetings;
    },
  } as unknown as AkLeg;
  const scout = aklegScout({
    id: "akleg",
    name: "akleg",
    committees: { hres: "HRES" },
    schedule: "0 15 * * *",
    client,
  });
  const reports: ScoutedRecording[] = [];
  for await (const r of scout.scan({
    unseen: async (keys) =>
      keys.filter((k) => k.external_id !== "HRES 2026-03-02 13:00:00"),
    logger: runLogger({ sink: () => {}, annotate: false }).child("akleg"),
    signal: new AbortController().signal,
    now,
  })) {
    reports.push(r);
  }
  return { reports, asked };
}

describe("the akleg scout", () => {
  it("reports unseen meetings of the sitting Legislature, a day after they start", async () => {
    const { reports, asked } = await scan(
      [
        meeting("HRES 2026-03-06 13:00:00"),
        meeting("HRES 2026-03-05 13:00:00"),
        meeting("HRES 2026-03-04 13:00:00", { cancelled: true }),
        meeting("HRES 2026-03-03 13:00:00"),
        meeting("HRES 2026-03-02 13:00:00"),
      ],
      new Date("2026-03-06T20:00:00Z"),
    );
    expect(asked).toEqual([["HRES", 34]]);
    expect(reports.map((r) => r.external_id)).toEqual([
      "HRES 2026-03-03 13:00:00",
    ]);
    expect(reports[0]).toMatchObject({
      title: "House RESOURCES - 2026-03-03 13:00:00",
      duration_secs: 600,
      is_meeting: true,
      bodies: ["hres"],
    });
  });
});
