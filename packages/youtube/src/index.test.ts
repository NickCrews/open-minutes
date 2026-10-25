import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureYtDlpInstalled, run, runWithEgress } from "@open-minutes/ytdlp";
import {
  youtube,
  youtubeConfigFromEnv,
  youtubeFromEnv,
  youtubeSource,
} from ".";
import { existsSync } from "node:fs";

// yt-dlp runs for real unless a test replaces run's or runWithEgress's
// implementation.
vi.mock("@open-minutes/ytdlp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@open-minutes/ytdlp")>();
  return {
    ...actual,
    ensureYtDlpInstalled: vi.fn(actual.ensureYtDlpInstalled),
    run: vi.fn(actual.run),
    runWithEgress: vi.fn(actual.runWithEgress),
  };
});

describe("YouTube Module", () => {
  // A channel expands into one nested playlist per tab ("Videos", "Live", ...),
  // so these assert we walk down to the videos rather than handing back the
  // tabs. MOA is the regression case: it has both tabs, and returning them
  // unflattened made `om available` report exactly 2 channel-ID "videos".
  const channels = [
    { name: "GBOS", id: "UCOUlNInprZEjhbpVPiJOlEA", minVideos: 10 },
    { name: "MOA", id: "UCZDEuWj4IxdlwBhqrk62_XA", minVideos: 1000 },
  ];

  it.each(channels)(
    "should fetch videos in the $name channel",
    // MOA's flat playlist is thousands of entries and several MB of JSON, so
    // scraping it takes about a minute.
    { tags: ["ytdlp"] },
    async ({ id, minVideos }) => {
      const videos = await youtubeSource({
        kind: "channel",
        id,
      }).listRecordings();
      expect(videos).toBeInstanceOf(Array);
      expect(videos.length).toBeGreaterThan(minVideos);
      expect(videos[0]).toHaveProperty("id");
      expect(videos[0]).toHaveProperty("title");
      for (const video of videos) {
        expect(video.id).not.toBe(id);
      }
      expect(new Set(videos.map((v) => v.id)).size).toBe(videos.length);
    },
  );

  // A 5 sec video, in the object store.
  const sampleVideo = "https://www.youtube.com/watch?v=QUF1uLgzL-s";

  /** Downloads sampleVideo's audio with `yt` twice: once fetched, once already there. */
  async function expectDownloads(yt: ReturnType<typeof youtube>) {
    const dir = await mkdtemp(join(tmpdir(), "youtube-download-"));
    try {
      const path = join(dir, "short.wav");
      let result = await yt.ensureAudioDownloaded(sampleVideo, path);
      expect(existsSync(path)).toBe(true);
      expect(result).toHaveProperty("downloaded", true);
      result = await yt.ensureAudioDownloaded(sampleVideo, path);
      expect(result).toHaveProperty("downloaded", false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // YouTube makes datacenter IPs (like GitHub's runners) "sign in to confirm
  // you're not a bot", so CI reads from the object store (see fetchStored).
  it.skipIf(!process.env.OBJECT_STORE_PUBLIC_URL)(
    "should download video audio from the object store",
    () => expectDownloads(youtubeFromEnv()),
    // The sample is in the store, so this takes a second or two. A miss waits
    // on a fetch-youtube-audio run, which takes 2-6 minutes.
    5 * 60_000,
  );

  it("should download video audio with yt-dlp", { tags: ["ytdlp"] }, () =>
    expectDownloads(youtube({ routes: youtubeConfigFromEnv().routes })),
  );
});

describe("youtubeConfigFromEnv", () => {
  it("reads YOUTUBE_EGRESS as a comma-separated list of routes", () => {
    expect(
      youtubeConfigFromEnv({
        YOUTUBE_EGRESS: " warp, ,socks5://127.0.0.1:9050,",
      }).routes,
    ).toEqual(["warp", "socks5://127.0.0.1:9050"]);
  });

  it.each([{}, { YOUTUBE_EGRESS: "" }, { YOUTUBE_EGRESS: " , " }])(
    "leaves the routes to @open-minutes/ytdlp for %j",
    (env) => {
      expect(youtubeConfigFromEnv(env).routes).toBeUndefined();
    },
  );
});

describe("yt-dlp", () => {
  const INFO = JSON.stringify({ id: "QUF1uLgzL-s", title: "Short" });
  const fixture = new URL("./fixtures/tones.webm", import.meta.url);

  beforeEach(() => {
    vi.mocked(ensureYtDlpInstalled).mockResolvedValue();
  });

  afterEach(() => {
    vi.mocked(ensureYtDlpInstalled).mockReset();
    vi.mocked(run).mockReset();
    vi.mocked(runWithEgress).mockReset();
  });

  it("gets metadata through the configured routes", async () => {
    vi.mocked(runWithEgress).mockResolvedValue({
      stdout: INFO,
      stderr: "",
      route: "tor",
    });
    const meta = await youtube({ routes: ["tor"] }).getMetadata("QUF1uLgzL-s");
    expect(meta.title).toBe("Short");
    expect(runWithEgress).toHaveBeenCalledWith(
      ["--skip-download", "-J", "https://www.youtube.com/watch?v=QUF1uLgzL-s"],
      expect.objectContaining({ routes: ["tor"] }),
    );
  });

  it("downloads audio, clearing the partial file before each attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youtube-ytdlp-"));
    try {
      const wav = join(dir, "audio.wav");
      const webm = `${wav}.webm`;
      const leftovers: boolean[] = [];
      vi.mocked(runWithEgress).mockImplementation(
        async (args, { beforeAttempt } = {}) => {
          const out = args[args.indexOf("-o") + 1]!;
          // A first attempt that leaves a partial file, then one that works.
          await beforeAttempt?.();
          leftovers.push(existsSync(`${webm}.part`));
          await copyFile(fixture, `${out}.part`);
          await beforeAttempt?.();
          leftovers.push(existsSync(`${webm}.part`));
          await copyFile(fixture, out);
          return { stdout: "", stderr: "", route: "warp" };
        },
      );
      const result = await youtube({}).ensureAudioDownloaded(
        "QUF1uLgzL-s",
        wav,
      );
      expect(result).toEqual({ downloaded: true });
      expect(existsSync(wav)).toBe(true);
      expect(existsSync(webm)).toBe(false);
      expect(leftovers).toEqual([false, false]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists a source directly, without egress", async () => {
    vi.mocked(run).mockResolvedValue({
      stdout: JSON.stringify({
        entries: [{ id: "QUF1uLgzL-s", title: "Short" }],
      }),
      stderr: "",
    });
    const videos = await youtubeSource({
      kind: "playlist",
      id: "PL123",
    }).listRecordings();
    expect(videos).toEqual([{ id: "QUF1uLgzL-s", title: "Short" }]);
    expect(run).toHaveBeenCalledWith([
      "--flat-playlist",
      "-J",
      "https://www.youtube.com/playlist?list=PL123",
    ]);
    expect(runWithEgress).not.toHaveBeenCalled();
  });
});
