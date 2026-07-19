import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatMeetingTime,
  toZonedInputValue,
  zonedInputValueToDate,
} from "./format";

const ANCHORAGE = "America/Anchorage";

describe("meeting times in a body's timezone", () => {
  it("renders an instant as the wall clock the body saw", () => {
    // 2026-06-15T03:00Z is 7 PM the previous evening in Anchorage (UTC-8, DST).
    const at = new Date("2026-06-15T03:00:00Z");
    expect(formatMeetingTime(at, ANCHORAGE)).toBe("June 14, 2026 7:00 PM");
  });

  it("does not depend on the machine's own timezone", () => {
    const at = new Date("2026-06-15T03:00:00Z");
    expect(formatMeetingTime(at, "America/New_York")).toBe(
      "June 14, 2026 11:00 PM",
    );
    expect(formatMeetingTime(at, "UTC")).toBe("June 15, 2026 3:00 AM");
  });
});

describe("datetime-local input round trip", () => {
  it("shows an instant as the body's wall clock", () => {
    const at = new Date("2026-06-15T03:00:00Z");
    expect(toZonedInputValue(at, ANCHORAGE)).toBe("2026-06-14T19:00");
  });

  it("reads a wall clock back as the same instant", () => {
    const at = zonedInputValueToDate("2026-06-14T19:00", ANCHORAGE);
    expect(at?.toISOString()).toBe("2026-06-15T03:00:00.000Z");
  });

  it("round trips across both sides of DST", () => {
    // Anchorage is UTC-8 in June and UTC-9 in January, so a helper that hard
    // coded one offset would pass the summer case and fail the winter one.
    for (const wall of ["2026-06-14T19:00", "2026-01-14T19:00"]) {
      const at = zonedInputValueToDate(wall, ANCHORAGE)!;
      expect(toZonedInputValue(at, ANCHORAGE)).toBe(wall);
    }
    expect(
      zonedInputValueToDate("2026-01-14T19:00", ANCHORAGE)?.toISOString(),
    ).toBe("2026-01-15T04:00:00.000Z");
  });

  it("handles midnight, which en-US renders as hour 24", () => {
    const at = zonedInputValueToDate("2026-06-14T00:00", ANCHORAGE)!;
    expect(toZonedInputValue(at, ANCHORAGE)).toBe("2026-06-14T00:00");
  });

  it("resolves the fall-back hour to a single instant", () => {
    // 1 AM happens twice on 2026-11-01 in Anchorage. Either instant is a
    // defensible reading; what matters is that we pick one and that rendering
    // it back yields the time that was typed, rather than drifting an hour.
    const at = zonedInputValueToDate("2026-11-01T01:00", ANCHORAGE)!;
    expect(toZonedInputValue(at, ANCHORAGE)).toBe("2026-11-01T01:00");
  });

  it("rejects a string that isn't a time", () => {
    expect(zonedInputValueToDate("", ANCHORAGE)).toBeNull();
    expect(zonedInputValueToDate("not a date", ANCHORAGE)).toBeNull();
  });
});

describe("durations", () => {
  it("spells out seconds by default", () => {
    expect(formatDuration("01:23:05.023")).toBe("1h 23m 5s");
    expect(formatDuration("00:23:05")).toBe("23m 5s");
    expect(formatDuration("00:00:05")).toBe("5s");
  });

  it("drops the seconds at minute precision", () => {
    expect(formatDuration("01:23:05.023", "minutes")).toBe("1h 23m");
    expect(formatDuration("00:23:05", "minutes")).toBe("23m");
  });

  it("keeps a whole hour's zero minutes, so it reads as a duration", () => {
    expect(formatDuration("01:00:00", "minutes")).toBe("1h 0m");
  });

  it("rounds to the nearest minute rather than truncating", () => {
    expect(formatDuration("00:23:45", "minutes")).toBe("24m");
    // Rounding up across the hour has to carry into the hours place.
    expect(formatDuration("01:59:45", "minutes")).toBe("2h 0m");
  });

  it("does not report a real duration as 0m", () => {
    expect(formatDuration("00:00:20", "minutes")).toBe("<1m");
  });

  it("passes through a string that isn't an interval", () => {
    expect(formatDuration("not an interval", "minutes")).toBe(
      "not an interval",
    );
  });
});
