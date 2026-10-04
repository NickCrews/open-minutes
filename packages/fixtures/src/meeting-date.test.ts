import { describe, expect, test } from "vitest";
import {
  openingText,
  parseDateTimeFromTranscript,
  resolveMeetingDateTime,
} from "@open-minutes/core/meeting-date";
import { getMeetingData } from "./test-data";

// When each golden meeting happened, read from its real title and transcript.
// The parsers' unit tests live beside them in @open-minutes/core.
describe("golden transcripts", () => {
  // What a human hears in the opening of each golden meeting.
  test.each([
    // "It's uh March 23rd, 2026, GBOS regular meeting. ... Call the meeting to
    // order seven o'clock."
    ["gbos-2026-03-23", { date: "2026-03-23", time: "19:00" }],
    // "Going to call the meeting to order here for the ... meeting. June 15th.
    // 7 o'clock." (no year spoken)
    ["gbos-2026-06-15", { date: "2026-06-15", time: "19:00" }],
    // The opening was not recorded; no date is stated, and the dates that are
    // mentioned (a hearing "scheduled for July 6th", minutes "from both April
    // 20th and April 27th") are not this meeting's.
    ["gbos-2026-05-18", null],
    // "We will call the June 8th, 2026 planning and zoning commission meeting
    // to order." (no time spoken)
    ["pzc-2026-06-08", { date: "2026-06-08", time: null }],
    // "Good evening, and welcome to the February seventeenth, 2026 regular
    // meeting of the Anchorage Assembly. It is now 503 PM." But that is 19
    // minutes in, after pre-meeting music, so it falls outside the opening.
    ["assembly-2026-02-17", null],
    // "It is 504 p.m." comes 20 minutes in, after pre-meeting music.
    ["assembly-2026-03-03", null],
    // "We'll call this meeting of the community and economic development
    // committee of the Anchorage Assembly to order Thursday, March 5th, 9 a.m."
    ["ced-2026-03-05", { date: "2026-03-05", time: "09:00" }],
  ] as const)("%s", (slug, expected) => {
    const meeting = getMeetingData(slug);
    const parsed = parseDateTimeFromTranscript(openingText(meeting.segments), {
      fallbackYear: 2026,
    });
    if (expected === null) expect(parsed).toBeNull();
    else expect(parsed).toMatchObject(expected);
  });

  test.each([
    [
      "gbos-2026-03-23",
      { date: "2026-03-23", time: "19:00", dateSource: "title" },
    ],
    [
      "gbos-2026-06-15",
      { date: "2026-06-15", time: "19:00", dateSource: "title" },
    ],
    [
      "gbos-2026-05-18",
      { date: "2026-05-18", time: null, dateSource: "title", timeSource: null },
    ],
    // MOA titles carry the scheduled start, eg "... - 2026-06-08 18:30:00".
    [
      "pzc-2026-06-08",
      {
        date: "2026-06-08",
        time: "18:30",
        dateSource: "title",
        timeSource: "title",
      },
    ],
    [
      "assembly-2026-02-17",
      {
        date: "2026-02-17",
        time: "17:00",
        dateSource: "title",
        timeSource: "title",
      },
    ],
    [
      "assembly-2026-03-03",
      {
        date: "2026-03-03",
        time: "17:00",
        dateSource: "title",
        timeSource: "title",
      },
    ],
    // The title has no date, and the chair's "Thursday, March 5th, 9 a.m."
    // has no year; the upload on March 9, 2026 places it.
    [
      "ced-2026-03-05",
      {
        date: "2026-03-05",
        time: "09:00",
        dateSource: "transcript",
        timeSource: "transcript",
      },
      "2026-03-09",
    ],
  ] as const)("resolve %s", (slug, expected, uploadDate?: string) => {
    const meeting = getMeetingData(slug);
    expect(
      resolveMeetingDateTime(meeting.title, openingText(meeting.segments), {
        uploadDate,
      }),
    ).toEqual({
      timeSource: "transcript",
      warnings: [],
      ...expected,
    });
  });
});
