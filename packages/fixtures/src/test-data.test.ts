import { describe, expect, it } from "vite-plus/test";
import { hasTypographicDash } from "@open-minutes/core/text";
import {
  loadAllTestData,
  loadPeople,
  parseGoldenBodies,
  parseGoldenWhen,
} from "./test-data";

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
    expect(parseGoldenBodies({ body_slugs: ["gbos"] }, "m.json")).toEqual([
      "gbos",
    ]);
    expect(
      parseGoldenBodies({ body_slugs: ["gbos", "luc"] }, "m.json"),
    ).toEqual(["gbos", "luc"]);
  });

  it("rejects a missing or non-list, no bodies, and duplicates", () => {
    expect(() => parseGoldenBodies({}, "m.json")).toThrow(/array of strings/);
    expect(() => parseGoldenBodies({ body_slugs: "gbos" }, "m.json")).toThrow(
      /array of strings/,
    );
    expect(() => parseGoldenBodies({ body_slugs: [] }, "m.json")).toThrow(
      /empty/,
    );
    expect(() =>
      parseGoldenBodies({ body_slugs: ["luc", "luc"] }, "m.json"),
    ).toThrow(/duplicates/);
  });
});

describe("recordings.jsonl", () => {
  const { bodies, recordings, meetings } = loadAllTestData();

  it("has every golden meeting's recording, once", () => {
    const keys = recordings.map((r) => `${r.site} ${r.external_id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const missing = meetings
      .filter((m) => !keys.includes(`youtube ${m.youtube_id}`))
      .map((m) => m.slug);
    expect(missing).toEqual([]);
  });

  it("names only bodies in bodies.jsonl, and a golden meeting's own", () => {
    const slugs = new Set(bodies.map((b) => b.slug));
    for (const r of recordings) {
      for (const b of r.body_slugs) expect(slugs).toContain(b);
      const meeting = meetings.find((m) => m.youtube_id === r.external_id);
      if (meeting) {
        expect(r.is_meeting).toBe(true);
        expect([...r.body_slugs].sort()).toEqual(
          [...meeting.body_slugs].sort(),
        );
      }
    }
  });

  it("has a recording that isn't a meeting", () => {
    expect(recordings.some((r) => r.is_meeting === false)).toBe(true);
  });
});
