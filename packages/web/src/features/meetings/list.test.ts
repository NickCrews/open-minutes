import { describe, expect, it } from "vitest";
import {
  filterMeetings,
  groupByMonth,
  meetingMonth,
  sortMeetings,
  summarizeMeetings,
  type ListedMeeting,
} from "./list";

const GBOS = { id: 1, name: "Borough Assembly", timezone: "America/Anchorage" };
const PLAN = { id: 2, name: "Planning Commission", timezone: "UTC" };

function meeting(
  title: string,
  at: string | null,
  body = GBOS,
): ListedMeeting & { id: string } {
  return {
    id: title,
    title,
    start_time: at ? new Date(at) : null,
    body,
  };
}

describe("meetingMonth", () => {
  it("reads the month in the body's timezone, not UTC", () => {
    // 2026-07-01T02:00Z is 6 PM on June 30th in Anchorage.
    const m = meetingMonth(meeting("a", "2026-07-01T02:00:00Z"));
    expect(m).toEqual({ key: "2026-06", long: "June 2026", short: "Jun 2026" });
  });

  it("is null when the date isn't known", () => {
    expect(meetingMonth(meeting("a", null))).toBeNull();
  });
});

describe("sortMeetings", () => {
  it("puts the most recent first and undated meetings last", () => {
    const sorted = sortMeetings([
      meeting("old", "2020-01-10T20:00:00Z"),
      meeting("undated", null),
      meeting("new", "2026-01-10T20:00:00Z"),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["new", "old", "undated"]);
  });
});

describe("filterMeetings", () => {
  const all = [
    meeting("Regular Meeting", "2026-01-10T20:00:00Z", GBOS),
    meeting("Budget Work Session", "2026-02-10T20:00:00Z", GBOS),
    meeting("Regular Meeting", "2026-03-10T20:00:00Z", PLAN),
  ];

  it("keeps everything with no filters", () => {
    expect(filterMeetings(all, {})).toHaveLength(3);
  });

  it("matches every word against the title or body name", () => {
    expect(filterMeetings(all, { q: "regular planning" })).toEqual([all[2]]);
    expect(filterMeetings(all, { q: "  BUDGET  " })).toEqual([all[1]]);
    expect(filterMeetings(all, { q: "budget planning" })).toEqual([]);
  });

  it("narrows to the selected bodies", () => {
    expect(filterMeetings(all, { bodies: [2] })).toEqual([all[2]]);
    expect(filterMeetings(all, { bodies: [1, 2] })).toHaveLength(3);
    expect(filterMeetings(all, { bodies: [] })).toHaveLength(3);
  });
});

describe("groupByMonth", () => {
  it("groups consecutive meetings from the same month", () => {
    const groups = groupByMonth([
      meeting("a", "2026-06-20T20:00:00Z"),
      meeting("b", "2026-06-02T20:00:00Z"),
      meeting("c", "2026-04-02T20:00:00Z"),
      meeting("d", null),
    ]);
    expect(
      groups.map((g) => [g.month?.long ?? null, g.meetings.length]),
    ).toEqual([
      ["June 2026", 2],
      ["April 2026", 1],
      [null, 1],
    ]);
  });
});

describe("summarizeMeetings", () => {
  const all = [
    meeting("a", "2026-09-02T20:00:00Z"),
    meeting("b", "2018-06-02T20:00:00Z"),
    meeting("c", null),
  ];

  it("spans the earliest and latest dated meetings", () => {
    expect(summarizeMeetings(all, 3)).toBe(
      "3 meetings from Jun 2018 to Sep 2026",
    );
  });

  it("says how many of the total a filter left", () => {
    expect(summarizeMeetings([all[0]!], 3)).toBe("1 of 3 meetings in Sep 2026");
  });

  it("drops the span when nothing is dated", () => {
    expect(summarizeMeetings([all[2]!], 1)).toBe("1 meeting");
    expect(summarizeMeetings([], 3)).toBe("0 of 3 meetings");
  });
});
