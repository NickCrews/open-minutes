import { describe, expect, it } from "vite-plus/test";
import { isNotStartedYet, metadataFromYtDlpInfo } from "./core";

describe("metadataFromYtDlpInfo", () => {
  it("falls back to a watch URL and nulls for missing fields", () => {
    expect(metadataFromYtDlpInfo({ id: "QUF1uLgzL-s" })).toEqual({
      id: "QUF1uLgzL-s",
      permalink: "https://www.youtube.com/watch?v=QUF1uLgzL-s",
      channelId: "",
      title: "",
      description: "",
      durationSecs: null,
      publishedAt: null,
    });
  });

  it("dates a stream by its start, not its upload", () => {
    const meta = metadataFromYtDlpInfo({
      id: "QUF1uLgzL-s",
      timestamp: 1_774_400_000,
      release_timestamp: 1_774_390_000,
    });
    expect(meta.publishedAt).toEqual(new Date(1_774_390_000_000));
  });

  it("gives no duration for a stream that hasn't finished", () => {
    for (const live_status of ["is_upcoming", "is_live", "post_live"]) {
      const meta = metadataFromYtDlpInfo({
        id: "QUF1uLgzL-s",
        duration: 0,
        live_status,
      });
      expect(meta.durationSecs).toBeNull();
    }
    const done = metadataFromYtDlpInfo({
      id: "QUF1uLgzL-s",
      duration: 9970,
      live_status: "was_live",
    });
    expect(done.durationSecs).toBe(9970);
  });
});

describe("isNotStartedYet", () => {
  it("recognizes a stream or premiere that hasn't started", () => {
    for (const stderr of [
      "ERROR: [youtube] JpOST0YiUAE: This live event will begin in 91 minutes.",
      "ERROR: [youtube] JpOST0YiUAE: This live event will begin in a few moments.",
      "ERROR: [youtube] JpOST0YiUAE: Premieres in 2 hours",
    ]) {
      expect(isNotStartedYet(stderr)).toBe(true);
    }
  });

  it("doesn't take YouTube's bot check or a removed video for one", () => {
    for (const stderr of [
      "ERROR: [youtube] f-_xtYePqz0: Sign in to confirm you’re not a bot.",
      "ERROR: [youtube] f-_xtYePqz0: Video unavailable",
    ]) {
      expect(isNotStartedYet(stderr)).toBe(false);
    }
  });
});
