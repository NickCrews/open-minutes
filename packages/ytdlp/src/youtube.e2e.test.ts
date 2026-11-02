import { beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureYtDlpInstalled, runWithEgress } from ".";

// Fetches from YouTube through the default routes: direct on a home
// connection, WARP or Tor on a GitHub runner (the ytdlp workflow installs
// them). The test is the same on both.
describe("yt-dlp against YouTube", () => {
  // A 5 sec video.
  const id = "QUF1uLgzL-s";
  const url = `https://www.youtube.com/watch?v=${id}`;

  beforeAll(() => ensureYtDlpInstalled(), 2 * 60_000);

  it("fetches a video's metadata", { tags: ["ytdlp"] }, async () => {
    const { stdout, route } = await runWithEgress([
      "--skip-download",
      "-J",
      url,
    ]);
    console.error(`metadata came via ${route}`);
    const info = JSON.parse(stdout) as { id: string; duration: number };
    expect(info.id).toBe(id);
    expect(info.duration).toBeGreaterThan(0);
  });

  it("downloads a video's audio", { tags: ["ytdlp"] }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ytdlp-e2e-"));
    try {
      const out = join(dir, "audio.webm");
      const { route } = await runWithEgress(
        ["-f", "bestaudio[ext=webm]", "--no-playlist", "-o", out, url],
        { beforeAttempt: () => rm(`${out}.part`, { force: true }) },
      );
      console.error(`audio came via ${route}`);
      expect((await stat(out)).size).toBeGreaterThan(10_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
