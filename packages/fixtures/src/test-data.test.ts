import { describe, expect, it } from "vitest";
import { hasTypographicDash } from "@open-minutes/core/text";
import { loadPeople, parseGoldenWhen } from "./test-data";

describe("people.jsonl", () => {
  it("uses a plain hyphen, not an en or em dash, in names and bios", () => {
    const withDash = loadPeople()
      .filter((p) => hasTypographicDash(`${p.name} ${p.bio ?? ""}`))
      .map((p) => p.slug);
    expect(withDash).toEqual([]);
  });
});

describe("parseGoldenWhen", () => {
  it("treats absent fields as unknown", () => {
    expect(parseGoldenWhen({}, "m.json")).toEqual({ date: null, time: null });
  });

  it("keeps a date with no time as time-unknown", () => {
    expect(parseGoldenWhen({ date: "2026-06-15" }, "m.json")).toEqual({
      date: "2026-06-15",
      time: null,
    });
  });

  it("normalizes a time to HH:MM:SS", () => {
    expect(
      parseGoldenWhen({ date: "2026-06-15", time: "19:00" }, "m.json"),
    ).toEqual({ date: "2026-06-15", time: "19:00:00" });
  });

  it("rejects malformed values and a time without a date", () => {
    expect(() => parseGoldenWhen({ date: "June 15" }, "m.json")).toThrow(
      /invalid date/,
    );
    expect(() =>
      parseGoldenWhen({ date: "2026-06-15", time: "7pm" }, "m.json"),
    ).toThrow(/invalid time/);
    expect(() => parseGoldenWhen({ time: "19:00" }, "m.json")).toThrow(
      /no date/,
    );
  });
});
