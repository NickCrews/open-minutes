import { describe, expect, it } from "vitest";
import {
  compareMeetingsNewestFirst,
  formatMeetingDate,
  formatMonthYear,
  formatTimeOfDay,
  parseMeetingDate,
  parseMeetingTime,
} from "./meeting-date";

describe("formatMeetingDate", () => {
  it("shows date and time when both are known", () => {
    expect(formatMeetingDate({ date: "2026-06-14", time: "19:30:00" })).toBe(
      "June 14, 2026 7:30 PM",
    );
  });

  it("shows only the date when the time is unknown, never midnight", () => {
    expect(formatMeetingDate({ date: "2026-06-14", time: null })).toBe(
      "June 14, 2026",
    );
  });

  it("is null when the date is unknown", () => {
    expect(formatMeetingDate({ date: null, time: null })).toBeNull();
  });

  it("renders a real midnight as a time, since it was given", () => {
    expect(formatMeetingDate({ date: "2026-06-14", time: "00:00:00" })).toBe(
      "June 14, 2026 12:00 AM",
    );
  });

  it("does not shift the day through the machine's timezone", () => {
    // A naive `new Date("2026-01-01")` is UTC midnight, which reads as Dec 31
    // anywhere west of Greenwich. The helpers must not go through local time.
    const tz = process.env.TZ;
    process.env.TZ = "America/Anchorage";
    try {
      expect(formatMeetingDate({ date: "2026-01-01", time: null })).toBe(
        "January 1, 2026",
      );
      expect(formatMonthYear("2026-01-01")).toBe("Jan 2026");
    } finally {
      process.env.TZ = tz;
    }
  });
});

describe("formatTimeOfDay", () => {
  it("accepts times with or without seconds", () => {
    expect(formatTimeOfDay("07:05")).toBe("7:05 AM");
    expect(formatTimeOfDay("12:00:00")).toBe("12:00 PM");
    expect(formatTimeOfDay("23:59:59")).toBe("11:59 PM");
  });
});

describe("parsing", () => {
  it("accepts real calendar dates", () => {
    expect(parseMeetingDate("2026-06-14")).toBe("2026-06-14");
    expect(parseMeetingDate(" 2024-02-29 ")).toBe("2024-02-29");
  });

  it("rejects malformed or impossible dates", () => {
    for (const bad of ["", "2026-6-14", "June 14, 2026", "2026-02-30"]) {
      expect(parseMeetingDate(bad)).toBeNull();
    }
    expect(parseMeetingDate("2025-02-29")).toBeNull();
  });

  it("normalizes times to HH:MM:SS", () => {
    expect(parseMeetingTime("19:30")).toBe("19:30:00");
    expect(parseMeetingTime("19:30:15")).toBe("19:30:15");
  });

  it("rejects malformed or impossible times", () => {
    for (const bad of ["", "7:30", "24:00", "12:60", "7:30 PM"]) {
      expect(parseMeetingTime(bad)).toBeNull();
    }
  });
});

describe("compareMeetingsNewestFirst", () => {
  it("orders by date then time, newest first, unknowns last", () => {
    const meetings = [
      { id: 1, date: null, time: null },
      { id: 2, date: "2026-06-14", time: null },
      { id: 3, date: "2026-06-14", time: "09:00:00" },
      { id: 4, date: "2026-06-14", time: "19:00:00" },
      { id: 5, date: "2025-12-01", time: "19:00:00" },
      { id: 6, date: "2026-07-01", time: null },
    ];
    expect(meetings.sort(compareMeetingsNewestFirst).map((m) => m.id)).toEqual([
      6, 4, 3, 2, 5, 1,
    ]);
  });
});
