import { describe, expect, it } from "vite-plus/test";
import { isComplete } from "@open-minutes/youtube";
import { judgeTitle, scoutedFromInfo } from "./youtube";

describe("scoutedFromInfo", () => {
  it("reads yt-dlp's info JSON", () => {
    expect(
      scoutedFromInfo({
        id: "9HoIM5INxpI",
        title: "Girdwood Board of Supervisors Regular Meeting March 23, 2026",
        description: "www.muni.org/gbos",
        duration: 9970,
        timestamp: 1774379128,
        release_timestamp: null,
        live_status: "not_live",
        webpage_url: "https://www.youtube.com/watch?v=9HoIM5INxpI",
      }),
    ).toEqual({
      site: "youtube",
      external_id: "9HoIM5INxpI",
      permalink: "https://www.youtube.com/watch?v=9HoIM5INxpI",
      title: "Girdwood Board of Supervisors Regular Meeting March 23, 2026",
      description: "www.muni.org/gbos",
      published_at: new Date("2026-03-24T19:05:28Z"),
      duration_secs: 9970,
      is_meeting: null,
      notes: "",
      bodies: [],
    });
  });

  it("dates a stream by when it started", () => {
    expect(
      scoutedFromInfo({ id: "x", timestamp: 2000, release_timestamp: 1000 })
        .published_at,
    ).toEqual(new Date(1_000_000));
  });
});

describe("judgeTitle", () => {
  it.each([
    ["Assembly Regular Meeting", null],
    ["TEST stream", false],
    ["Sound test", false],
    ["Testimony on AO 2026-12", null],
  ])("%j: is_meeting %j", (title, is_meeting) => {
    expect(judgeTitle(title).is_meeting).toBe(is_meeting);
  });
});

describe("isComplete", () => {
  it.each([
    [undefined, true],
    ["not_live", true],
    ["was_live", true],
    ["is_live", false],
    ["is_upcoming", false],
    ["post_live", false],
  ] as const)("live_status %j: %j", (live_status, complete) => {
    expect(isComplete({ id: "x", live_status })).toBe(complete);
  });
});
