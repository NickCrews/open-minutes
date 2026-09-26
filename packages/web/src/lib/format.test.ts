import { describe, expect, it } from "vitest";
import { formatDuration, formatZoneAbbreviation } from "./format";

describe("zone abbreviations", () => {
  it("follows DST for the moment given", () => {
    const tz = "America/Anchorage";
    expect(formatZoneAbbreviation(new Date("2026-06-14T20:00:00Z"), tz)).toBe(
      "AKDT",
    );
    expect(formatZoneAbbreviation(new Date("2026-01-14T20:00:00Z"), tz)).toBe(
      "AKST",
    );
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
