import { describe, expect, it } from "vitest";
import { hasTypographicDash } from "@open-minutes/core/text";
import { meetingBodyIds } from "./seed/map";
import { loadPeople, parseGoldenBodies, parseGoldenWhen } from "./test-data";

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

describe("parseGoldenBodies", () => {
  it("keeps one body, or a joint meeting's several", () => {
    expect(parseGoldenBodies({ body_ids: ["gbos"] }, "m.json")).toEqual([
      "gbos",
    ]);
    expect(parseGoldenBodies({ body_ids: ["gbos", "luc"] }, "m.json")).toEqual([
      "gbos",
      "luc",
    ]);
  });

  it("rejects a missing or non-list, no bodies, and duplicates", () => {
    expect(() => parseGoldenBodies({}, "m.json")).toThrow(/array of strings/);
    expect(() => parseGoldenBodies({ body_ids: "gbos" }, "m.json")).toThrow(
      /array of strings/,
    );
    expect(() => parseGoldenBodies({ body_ids: [] }, "m.json")).toThrow(
      /empty/,
    );
    expect(() =>
      parseGoldenBodies({ body_ids: ["luc", "luc"] }, "m.json"),
    ).toThrow(/duplicates/);
  });
});

describe("meetingBodyIds", () => {
  const ids = new Map([
    ["gbos", 1],
    ["luc", 2],
  ]);

  it("resolves the bodies to database ids", () => {
    expect(
      meetingBodyIds({ slug: "m", body_ids: ["gbos", "luc"] }, ids),
    ).toEqual([1, 2]);
  });

  it("refuses a body bodies.jsonl doesn't have", () => {
    expect(() =>
      meetingBodyIds({ slug: "m", body_ids: ["gbos", "nope"] }, ids),
    ).toThrow(/unknown body "nope"/);
  });
});
