import { describe, expect, it } from "vitest";
import { hasTypographicDash } from "@open-minutes/core/text";
import { meetingBodyIds } from "./seed/map";
import { loadPeople, parseGoldenCohosts, parseGoldenWhen } from "./test-data";

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

describe("parseGoldenCohosts", () => {
  it("treats an absent list as no co-hosts", () => {
    expect(parseGoldenCohosts({ body_id: "gbos" }, "m.json")).toEqual([]);
  });

  it("keeps a joint meeting's other bodies", () => {
    expect(
      parseGoldenCohosts(
        { body_id: "gbos", cohost_body_ids: ["luc"] },
        "m.json",
      ),
    ).toEqual(["luc"]);
  });

  it("rejects a non-list, the host, and duplicates", () => {
    expect(() =>
      parseGoldenCohosts({ body_id: "gbos", cohost_body_ids: "luc" }, "m.json"),
    ).toThrow(/array of strings/);
    expect(() =>
      parseGoldenCohosts(
        { body_id: "gbos", cohost_body_ids: ["gbos"] },
        "m.json",
      ),
    ).toThrow(/host body/);
    expect(() =>
      parseGoldenCohosts(
        { body_id: "gbos", cohost_body_ids: ["luc", "luc"] },
        "m.json",
      ),
    ).toThrow(/duplicates/);
  });
});

describe("meetingBodyIds", () => {
  const ids = new Map([
    ["gbos", 1],
    ["luc", 2],
  ]);

  it("resolves the host and co-hosts to database ids", () => {
    expect(
      meetingBodyIds(
        { slug: "m", body_id: "gbos", cohost_body_ids: ["luc"] },
        ids,
      ),
    ).toEqual({ bodyId: 1, cohostIds: [2] });
  });

  it("refuses a body bodies.jsonl doesn't have", () => {
    expect(() =>
      meetingBodyIds(
        { slug: "m", body_id: "gbos", cohost_body_ids: ["nope"] },
        ids,
      ),
    ).toThrow(/unknown body "nope"/);
  });
});
