import { describe, it, expect, vi, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  youtube,
  youtubeConfigFromEnv,
  youtubeFromEnv,
  youtubeSource,
} from ".";
import { rmSync, existsSync } from "node:fs";

// yt-dlp runs for real unless a test replaces execFile's implementation.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

describe("YouTube Module", () => {
  const yt = youtubeFromEnv();

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
    { tags: ["slow"] },
    async ({ id, minVideos }) => {
      const videos = await youtubeSource({ kind: "channel", id }).listVideos();
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

  // YouTube makes datacenter IPs (like GitHub's runners) "sign in to confirm
  // you're not a bot", so in CI this reads from the object store
  // (OBJECT_STORE_PUBLIC_URL; see fetchStored). A run without it skips.
  it.skipIf(process.env.CI && !process.env.OBJECT_STORE_PUBLIC_URL)(
    "should download video audio",
    async () => {
      // A 5 sec video for testing
      const sampleVideo = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
      const path = new URL("./test_audio/short.wav", import.meta.url).pathname;
      // Clean up any existing file before test
      rmSync(path, { force: true });
      expect(existsSync(path)).toBe(false);
      let result = await yt.ensureAudioDownloaded(sampleVideo, path, {
        overwrite: true,
      });
      expect(existsSync(path)).toBe(true);
      expect(result).toHaveProperty("downloaded", true);
      result = await yt.ensureAudioDownloaded(sampleVideo, path);
      expect(result).toHaveProperty("downloaded", false);
    },
    // The sample is in the store, so this takes a second or two. A miss waits
    // on a fetch-youtube-audio run, which takes 2-6 minutes.
    5 * 60_000,
  );
});

describe("youtubeConfigFromEnv", () => {
  it("reads YOUTUBE_PROXY as a comma-separated list", () => {
    expect(
      youtubeConfigFromEnv({
        YOUTUBE_PROXY: " socks5://127.0.0.1:40000, ,socks5://127.0.0.1:9050,",
      }).proxies,
    ).toEqual(["socks5://127.0.0.1:40000", "socks5://127.0.0.1:9050"]);
  });

  it.each([{}, { YOUTUBE_PROXY: "" }, { YOUTUBE_PROXY: " , " }])(
    "has no proxies for %j",
    (env) => {
      expect(youtubeConfigFromEnv(env).proxies).toBeUndefined();
    },
  );
});

describe("yt-dlp through proxies", () => {
  const WARP = "socks5://127.0.0.1:40000";
  const TOR = "socks5://127.0.0.1:9050";
  const BOT_CHECK =
    "ERROR: [youtube] QUF1uLgzL-s: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.\n";
  const INFO = JSON.stringify({ id: "QUF1uLgzL-s", title: "Short" });

  type Reply = { stdout?: string; stderr?: string; fail?: boolean };

  /** Replaces yt-dlp with `reply`, and returns the args of each call. */
  function fakeYtDlp(reply: (args: string[]) => Reply | Promise<Reply>) {
    const calls: string[][] = [];
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      callback: (e: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push(args);
      void Promise.resolve(reply(args)).then(
        ({ stdout = "", stderr = "", fail }) => {
          const error = fail ? new Error("Command failed: yt-dlp") : null;
          callback(error, stdout, stderr);
        },
      );
      return {} as ChildProcess;
    }) as unknown as typeof execFile);
    return calls;
  }

  const proxyOf = (args: string[]) => {
    const i = args.indexOf("--proxy");
    return i === -1 ? undefined : args[i + 1];
  };

  afterEach(() => {
    vi.mocked(execFile).mockReset();
  });

  it("passes no --proxy without proxies", async () => {
    const calls = fakeYtDlp(() => ({ stdout: INFO }));
    const meta = await youtube({}).getMetadata("QUF1uLgzL-s");
    expect(meta.title).toBe("Short");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--proxy");
  });

  it("moves to the next proxy when one is bot-checked", async () => {
    const calls = fakeYtDlp((args) =>
      proxyOf(args) === WARP
        ? { fail: true, stderr: BOT_CHECK }
        : { stdout: INFO },
    );
    const meta = await youtube({ proxies: [WARP, TOR] }).getMetadata(
      "QUF1uLgzL-s",
    );
    expect(meta.id).toBe("QUF1uLgzL-s");
    expect(calls.map(proxyOf)).toEqual([WARP, TOR]);
  });

  it("moves to the next proxy when one can't be reached", async () => {
    const calls = fakeYtDlp((args) =>
      proxyOf(args) === WARP
        ? {
            fail: true,
            stderr:
              "ERROR: [youtube] QUF1uLgzL-s: Unable to download API page: Unable to connect to proxy\n",
          }
        : { stdout: INFO },
    );
    await youtube({ proxies: [WARP, TOR] }).getMetadata("QUF1uLgzL-s");
    expect(calls.map(proxyOf)).toEqual([WARP, TOR]);
  });

  it("doesn't retry an error that isn't a blocked exit", async () => {
    const calls = fakeYtDlp(() => ({
      fail: true,
      stderr: "ERROR: [youtube] QUF1uLgzL-s: Private video\n",
    }));
    await expect(
      youtube({ proxies: [WARP, TOR] }).getMetadata("QUF1uLgzL-s"),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Private") });
    expect(calls.map(proxyOf)).toEqual([WARP]);
  });

  it("names each proxy and its error when all fail", async () => {
    fakeYtDlp((args) => ({
      fail: true,
      stderr:
        proxyOf(args) === WARP
          ? BOT_CHECK
          : "[download] 1.0%\nERROR: unable to download video data: HTTP Error 403: Forbidden\n",
    }));
    const error = await youtube({ proxies: [WARP, TOR] })
      .getMetadata("QUF1uLgzL-s")
      .catch((e: Error) => e);
    expect((error as Error).message).toBe(
      [
        "yt-dlp failed through every proxy:",
        `  ${WARP}: ${BOT_CHECK.trim()}`,
        `  ${TOR}: ERROR: unable to download video data: HTTP Error 403: Forbidden`,
      ].join("\n"),
    );
  });

  it("downloads through the next proxy, clearing the partial file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youtube-proxy-"));
    try {
      const wav = join(dir, "audio.wav");
      const webm = `${wav}.webm`;
      const leftovers: boolean[] = [];
      const calls = fakeYtDlp(async (args) => {
        leftovers.push(existsSync(webm) || existsSync(`${webm}.part`));
        const out = args[args.indexOf("-o") + 1]!;
        if (proxyOf(args) === WARP) {
          await copyFile(
            new URL("./fixtures/tones.webm", import.meta.url),
            `${out}.part`,
          );
          return {
            fail: true,
            stderr: "ERROR: HTTP Error 429: Too Many Requests\n",
          };
        }
        await copyFile(new URL("./fixtures/tones.webm", import.meta.url), out);
        return {};
      });
      const result = await youtube({
        proxies: [WARP, TOR],
      }).ensureAudioDownloaded("QUF1uLgzL-s", wav);
      expect(result).toEqual({ downloaded: true });
      expect(existsSync(wav)).toBe(true);
      expect(existsSync(webm)).toBe(false);
      expect(leftovers).toEqual([false, false]);
      expect(calls.map(proxyOf)).toEqual([WARP, TOR]);
      for (const args of calls) {
        expect(args).toEqual(
          expect.arrayContaining(["--retries", "2", "--fragment-retries", "2"]),
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("downloads directly, with yt-dlp's own retries, without proxies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youtube-proxy-"));
    try {
      const wav = join(dir, "audio.wav");
      const calls = fakeYtDlp(async (args) => {
        const out = args[args.indexOf("-o") + 1]!;
        await copyFile(new URL("./fixtures/tones.webm", import.meta.url), out);
        return {};
      });
      await youtube({}).ensureAudioDownloaded("QUF1uLgzL-s", wav);
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("--proxy");
      expect(calls[0]).not.toContain("--retries");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never lists a source through a proxy", async () => {
    const calls = fakeYtDlp(() => ({
      stdout: JSON.stringify({
        entries: [{ id: "QUF1uLgzL-s", title: "Short" }],
      }),
    }));
    // listVideos takes no config, so even YOUTUBE_PROXY can't reach it.
    vi.stubEnv("YOUTUBE_PROXY", WARP);
    try {
      const videos = await youtubeSource({
        kind: "playlist",
        id: "PL123",
      }).listVideos();
      expect(videos).toEqual([{ id: "QUF1uLgzL-s", title: "Short" }]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--proxy");
  });
});
