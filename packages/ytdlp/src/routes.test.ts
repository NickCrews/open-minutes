import { describe, expect, it } from "vitest";
import { isBlockedExit } from "./blocked";
import { parseRoutes, routesFromEnv } from "./routes";
import { YtDlpError } from "./run";

describe("parseRoutes", () => {
  it("reads a comma-separated list", () => {
    expect(parseRoutes(" warp, ,tor,socks5://127.0.0.1:9050,")).toEqual([
      "warp",
      "tor",
      "socks5://127.0.0.1:9050",
    ]);
  });

  it("rejects an unknown route", () => {
    expect(() => parseRoutes("direct,wrap")).toThrow(
      /Unknown yt-dlp route "wrap"/,
    );
  });
});

describe("routesFromEnv", () => {
  it.each([{}, { YOUTUBE_EGRESS: "" }, { YOUTUBE_EGRESS: " , " }])(
    "defaults to direct, WARP, then Tor for %j",
    (env) => {
      expect(routesFromEnv(env)).toEqual(["direct", "warp", "tor"]);
    },
  );

  it("reads YOUTUBE_EGRESS", () => {
    expect(routesFromEnv({ YOUTUBE_EGRESS: "warp,tor" })).toEqual([
      "warp",
      "tor",
    ]);
  });
});

describe("isBlockedExit", () => {
  const error = (stderr: string) =>
    new YtDlpError([], "", stderr, new Error("exit 1"));

  it.each([
    "ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser",
    "ERROR: [youtube] x: Sign in to confirm you're not a bot.",
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "ERROR: HTTP Error 429: Too Many Requests",
    "ERROR: [youtube] x: Unable to download API page: Unable to connect to proxy",
    "ERROR: [youtube] x: This content isn't available, try again later.",
  ])("counts %j as blocked", (stderr) => {
    expect(isBlockedExit(error(stderr))).toBe(true);
  });

  it.each([
    "ERROR: [youtube] x: Private video. Sign in if you've been granted access",
    "ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader",
  ])("doesn't count %j as blocked", (stderr) => {
    expect(isBlockedExit(error(stderr))).toBe(false);
  });
});
