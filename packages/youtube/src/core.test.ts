import { describe, expect, it } from "vite-plus/test";
import { metadataFromYtDlpInfo } from "./core";

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
});
