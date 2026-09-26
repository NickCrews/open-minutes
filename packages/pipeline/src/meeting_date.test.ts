import { describe, expect, test } from "vitest";
import { getMeetingData } from "./test-utils/test-data";
import {
  openingText,
  parseDateFromTitle,
  parseDateTimeFromTranscript,
  resolveMeetingDateTime,
} from "./meeting_date";

describe("parseDateFromTitle", () => {
  // Real titles, scraped from the GBOS channel (UCOUlNInprZEjhbpVPiJOlEA) and
  // the MOA channel (UCZDEuWj4IxdlwBhqrk62_XA, Assembly and its siblings) in
  // September 2026. [title, date, time]
  const REAL_TITLES: Array<[string, string | null, string | null]> = [
    // GBOS: "<Month> <D>, <YYYY>" and friends
    [
      "Girdwood Board of Supervisors Regular Meeting June 15, 2026",
      "2026-06-15",
      null,
    ],
    [
      "Girdwood Board of Supervisors Regular Meeting  May 18, 2026",
      "2026-05-18",
      null,
    ],
    [
      "Girdwood Board of Supervisors Regular Meeting August 19th, 2024",
      "2024-08-19",
      null,
    ],
    [
      "Girdwood Board of Supervisors December 18th, 2023 Regular Meeting",
      "2023-12-18",
      null,
    ],
    [
      "Girdwood Board of Supervisors Work Session April 19th, 2023  2022 Year in Review",
      "2023-04-19",
      null,
    ],
    [
      "Girdwood Board of Supervisors Special Meeting May15, 2023",
      "2023-05-15",
      null,
    ],
    [
      "Girdwood Board of Supervisors and Girdwood Housing and Economic Committee Joint Meeting May 13,2023",
      "2023-05-13",
      null,
    ],
    [
      "Girdwood Board of Supervisors 2024 Budget Work Session #3 September 13, 2023",
      "2023-09-13",
      null,
    ],
    [
      "Girdwood Board of Supervisors Work Session September 30, 2024 Non-Profit Grants",
      "2024-09-30",
      null,
    ],
    ["GBOS & GFDBOD 11 13 2023", "2023-11-13", null],
    // A typo'd year is rejected rather than turned into year 206.
    [
      "Girdwood Board of Supervisors Regular Meeting February 23, 206",
      null,
      null,
    ],
    // No date at all.
    ["Girdwood Board of Supervisors Special Meeting 2027 Budgets", null, null],
    ["Girdwood Board of Supervisors 2025 Budget Work Session # 2", null, null],

    // MOA: an English date plus a generated ISO timestamp with the scheduled time.
    [
      "Assembly Regular - July 7, 2026 - 2026-07-07 17:00:00",
      "2026-07-07",
      "17:00",
    ],
    [
      "Planning and Zoning Commission - September 21, 2026 - 2026-09-21 18:30:00",
      "2026-09-21",
      "18:30",
    ],
    [
      "Assembly Special - April 22, 2026 - 2026-04-22 18:00:00",
      "2026-04-22",
      "18:00",
    ],
    // The ISO timestamp wins over a typo'd English year.
    [
      "Platting Board - February 4, 2025 - 2026-02-04 18:30:00",
      "2026-02-04",
      "18:30",
    ],
    [
      "Assembly Regular - September 15, 2026@uO1wt6JTmrY - 2026-09-15 17:00:00",
      "2026-09-15",
      "17:00",
    ],
    ["Assembly Regular - September 15, 2026", "2026-09-15", null],
    ["Regular Assembly Meeting - September 1, 2026", "2026-09-01", null],
    [
      "Platting Board: August 5, 2026 - 2026-08-05 18:30:00",
      "2026-08-05",
      "18:30",
    ],
    ["Sister Cities Commission 2026-05-20", "2026-05-20", null],
    [
      "ACCEE Fund Board Meeting 2026 05 20 Meeting Recording",
      "2026-05-20",
      null,
    ],
    [
      "Military and Veterans Affairs Commission Meeting Recording 2026-03-02",
      "2026-03-02",
      null,
    ],
    ["9-3-26 Anchorage Women's Commission Meeting", "2026-09-03", null],
    ["Anchorage Women's Commission Meeting 8/6/26", "2026-08-06", null],
    ["6 4 26 Anchorage Womens Commission Meeting", "2026-06-04", null],
    ["12 4 25 Anchorage Womens Commission Meeting", "2025-12-04", null],
    // Month without a day, and no date at all.
    ["HHAND Commission Monthly Meeting September 2026", null, null],
    ["Board of Ethics Meeting", null, null],
    [
      "Worksession re AO 2026 16 and AO 2026 16S, amending Anchorage Municipal Code Title 11",
      null,
      null,
    ],
  ];

  test.each(REAL_TITLES)("%s", (title, date, time) => {
    const parsed = parseDateFromTitle(title);
    if (date === null) {
      expect(parsed).toBeNull();
    } else {
      expect(parsed).toMatchObject({ date, time, source: "title" });
    }
  });

  test.each([
    ["Regular Meeting 6/15/26", "2026-06-15"],
    ["Regular Meeting 6/15/2026", "2026-06-15"],
    ["Regular Meeting June 15th, 2026", "2026-06-15"],
    ["Regular Meeting June 15 2026", "2026-06-15"],
    ["Regular Meeting Jun. 15, 2026", "2026-06-15"],
    ["Regular Meeting Sept 3, 2026", "2026-09-03"],
    ["regular meeting JUNE 15, 2026", "2026-06-15"],
  ])("format variant %s", (title, date) => {
    expect(parseDateFromTitle(title)?.date).toBe(date);
  });

  test("a missing year needs a fallback", () => {
    expect(parseDateFromTitle("Regular Meeting Jun. 15")).toBeNull();
    expect(
      parseDateFromTitle("Regular Meeting Jun. 15", { fallbackYear: 2026 }),
    ).toMatchObject({ date: "2026-06-15", time: null });
    // Same for a typo'd year.
    expect(
      parseDateFromTitle(
        "Girdwood Board of Supervisors Regular Meeting February 23, 206",
        { fallbackYear: 2026 },
      )?.date,
    ).toBe("2026-02-23");
  });

  test("rejects impossible dates", () => {
    expect(parseDateFromTitle("Meeting February 30, 2026")).toBeNull();
    expect(parseDateFromTitle("Meeting 13/1/26")).toBeNull();
  });

  test("picks up a clock time elsewhere in the title", () => {
    expect(
      parseDateFromTitle("Special Meeting June 15, 2026 6:30 PM"),
    ).toMatchObject({ date: "2026-06-15", time: "18:30" });
  });
});

describe("parseDateTimeFromTranscript", () => {
  test("the canonical gavel-in", () => {
    const text =
      "Good evening. I'd like to call to order the regular meeting of the " +
      "Anchorage Assembly on Tuesday, June 15th, 2026 at 6:02 p.m. Clerk, " +
      "please call the roll.";
    expect(parseDateTimeFromTranscript(text)).toMatchObject({
      date: "2026-06-15",
      time: "18:02",
      source: "transcript",
      evidence: "June 15th, 2026 at 6:02 p.m.",
    });
  });

  test.each([
    ["call this meeting to order. It is 5:04 pm, July 7th, 2026.", "17:04"],
    ["call this meeting to order at 5 PM on July 7, 2026.", "17:00"],
    ["call this meeting to order at five oh four p.m. July 7, 2026", "17:04"],
    ["call this meeting to order at six thirty pm July 7, 2026", "18:30"],
    ["call this meeting to order at 9:15 a.m. July 7, 2026", "09:15"],
    ["call this meeting to order at 12:05 p.m. July 7, 2026", "12:05"],
    // No meridiem: 1–7 is afternoon/evening, 8–11 is morning.
    ["call the meeting to order, 7 o'clock, July 7, 2026", "19:00"],
    ["call the meeting to order, nine o'clock, July 7, 2026", "09:00"],
    ["call the meeting to order at 5:03. July 7, 2026", "17:03"],
  ])("time: %s", (text, time) => {
    expect(parseDateTimeFromTranscript(text)).toMatchObject({
      date: "2026-07-07",
      time,
    });
  });

  test("spoken ordinal days", () => {
    expect(
      parseDateTimeFromTranscript(
        "calling the regular meeting to order, today is June the fifteenth",
        { fallbackYear: 2026 },
      )?.date,
    ).toBe("2026-06-15");
    expect(
      parseDateTimeFromTranscript(
        "calling the regular meeting to order, it's March twenty-third, 2026",
      )?.date,
    ).toBe("2026-03-23");
  });

  test("ignores dates far from any anchor phrase", () => {
    const filler = " and so on".repeat(60);
    expect(
      parseDateTimeFromTranscript(
        `call the meeting to order.${filler} The hearing is scheduled July 6th, 2026.`,
      ),
    ).toBeNull();
    // No anchor at all.
    expect(
      parseDateTimeFromTranscript("The hearing is scheduled July 6th, 2026."),
    ).toBeNull();
  });

  test("the verb 'may' is not a month", () => {
    expect(
      parseDateTimeFromTranscript(
        "call the meeting to order. We may 2 things first, 2026",
      ),
    ).toBeNull();
  });

  test("a bare H:MM far from the gavel is not the start time", () => {
    const filler = " and so on".repeat(20);
    expect(
      parseDateTimeFromTranscript(
        `call the regular meeting to order, June 15th, 2026.${filler} Item 4:30 is next.`,
      ),
    ).toMatchObject({ date: "2026-06-15", time: null });
  });

  test("date without a year needs a fallback", () => {
    const text = "Going to call the meeting to order. June 15th. 7 o'clock.";
    expect(parseDateTimeFromTranscript(text)).toBeNull();
    expect(
      parseDateTimeFromTranscript(text, { fallbackYear: 2026 }),
    ).toMatchObject({ date: "2026-06-15", time: "19:00" });
  });
});

describe("golden transcripts", () => {
  // What a human hears in the opening of each golden meeting.
  test.each([
    // "It's uh March 23rd, 2026, GBOS regular meeting. ... Call the meeting to
    // order seven o'clock."
    ["gbos_9HoIM5INxpI", { date: "2026-03-23", time: "19:00" }],
    // "Going to call the meeting to order here for the ... meeting. June 15th.
    // 7 o'clock." (no year spoken)
    ["gbos_hTKVG_L61ec", { date: "2026-06-15", time: "19:00" }],
    // The opening was not recorded; no date is stated, and the dates that are
    // mentioned (a hearing "scheduled for July 6th", minutes "from both April
    // 20th and April 27th") are not this meeting's.
    ["gbos_xTDznaSElgY", null],
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
      "gbos_9HoIM5INxpI",
      { date: "2026-03-23", time: "19:00", dateSource: "title" },
    ],
    [
      "gbos_hTKVG_L61ec",
      { date: "2026-06-15", time: "19:00", dateSource: "title" },
    ],
    [
      "gbos_xTDznaSElgY",
      { date: "2026-05-18", time: null, dateSource: "title", timeSource: null },
    ],
  ] as const)("resolve %s", (slug, expected) => {
    const meeting = getMeetingData(slug);
    expect(
      resolveMeetingDateTime(meeting.title, openingText(meeting.segments)),
    ).toEqual({
      timeSource: "transcript",
      warnings: [],
      ...expected,
    });
  });
});

describe("openingText", () => {
  test("keeps only words in the opening window", () => {
    const segments = [
      {
        words: [
          { text: "call", start: 1 },
          { text: "to", start: 2 },
        ],
      },
      {
        words: [
          { text: "order", start: 3 },
          { text: "later", start: 700 },
        ],
      },
    ];
    expect(openingText(segments)).toBe("call to order");
    expect(openingText(segments, 2)).toBe("call to");
  });
});

describe("resolveMeetingDateTime", () => {
  const GAVEL =
    "call the regular meeting to order, June 16th, 2025 at 7:03 p.m.";

  test("title date, transcript time", () => {
    expect(
      resolveMeetingDateTime("Regular Meeting June 16, 2025", GAVEL),
    ).toEqual({
      date: "2025-06-16",
      time: "19:03",
      dateSource: "title",
      timeSource: "transcript",
      warnings: [],
    });
  });

  test("gavel time beats the title's scheduled time", () => {
    expect(
      resolveMeetingDateTime(
        "Assembly Regular - June 16, 2025 - 2025-06-16 19:00:00",
        GAVEL,
      ),
    ).toMatchObject({ time: "19:03", timeSource: "transcript", warnings: [] });
  });

  test("falls back to the title's scheduled time", () => {
    expect(
      resolveMeetingDateTime(
        "Assembly Regular - July 7, 2026 - 2026-07-07 17:00:00",
        "no gavel in the recording",
      ),
    ).toEqual({
      date: "2026-07-07",
      time: "17:00",
      dateSource: "title",
      timeSource: "title",
      warnings: [],
    });
  });

  test("falls back to the transcript's date", () => {
    expect(resolveMeetingDateTime("Board of Ethics Meeting", GAVEL)).toEqual({
      date: "2025-06-16",
      time: "19:03",
      dateSource: "transcript",
      timeSource: "transcript",
      warnings: [],
    });
  });

  test("nothing to go on", () => {
    expect(resolveMeetingDateTime("Board of Ethics Meeting", "hello")).toEqual({
      date: null,
      time: null,
      dateSource: null,
      timeSource: null,
      warnings: [],
    });
  });

  test("flags a title whose year is wrong", () => {
    // Real: this 2025 meeting was uploaded as "June 16, 2026".
    const resolved = resolveMeetingDateTime(
      "Girdwood Board of Supervisors Regular Meeting  June 16, 2026",
      GAVEL,
    );
    expect(resolved).toMatchObject({ date: "2026-06-16", dateSource: "title" });
    expect(resolved.warnings).toEqual([
      expect.stringMatching(
        /title date 2026-06-16 .* transcript date 2025-06-16/,
      ),
    ]);
  });

  test("flags a gavel time far from the scheduled time", () => {
    const resolved = resolveMeetingDateTime(
      "Assembly Regular - June 16, 2025 - 2025-06-16 12:00:00",
      GAVEL,
    );
    expect(resolved.time).toBe("19:03");
    expect(resolved.warnings).toEqual([
      expect.stringMatching(/title time 12:00 .* transcript time 19:03/),
    ]);
  });
});
