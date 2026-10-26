// Downloads the audio of one YouTube video, plus yt-dlp's metadata for it
// beside the audio (<output>.info.json, with the output's extension replaced).
// Usage: pnpm exec vpx .github/scripts/fetch-youtube-audio.ts <video id> <output file>
//
// The request goes out through runWithEgress's routes (YOUTUBE_EGRESS; the
// fetch-youtube-audio workflow sets warp,tor, since YouTube refuses GitHub's
// IPs). Expects packages/ytdlp/egress/install.sh to have run; see
// docs/research/youtube-in-ci.md.
//
// The output is YouTube's Opus audio as-is (format 251, ~50 MB per hour);
// encode-speech-audio.sh then shrinks it for the blob store. On failure,
// <output dir>/logs/last-error.txt says why, and WARP's and Tor's logs are
// copied beside it.
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  egressPaths,
  ensureYtDlpInstalled,
  runWithEgress,
} from "@open-minutes/ytdlp";

const [id, out] = process.argv.slice(2);
if (!id || !out) {
  console.error("Usage: fetch-youtube-audio.ts <video id> <output file>");
  process.exit(2);
}
const logs = join(dirname(out), "logs");
await mkdir(logs, { recursive: true });

try {
  await ensureYtDlpInstalled();
  const { route } = await runWithEgress(
    [
      "-f",
      "bestaudio[ext=webm]",
      "--no-playlist",
      "--write-info-json",
      "-o",
      out,
      `https://www.youtube.com/watch?v=${id}`,
    ],
    {
      beforeAttempt: async () => {
        await rm(out, { force: true });
        await rm(`${out}.part`, { force: true });
      },
    },
  );
  console.log(`downloaded via ${route}`);
} catch (error) {
  const message = (error as Error).message;
  console.error(message);
  await writeFile(join(logs, "last-error.txt"), `${message}\n`);
  process.exitCode = 1;
} finally {
  const { state } = egressPaths();
  const files = await readdir(state).catch(() => []);
  for (const f of files.filter((f) => f.endsWith(".log"))) {
    await copyFile(join(state, f), join(logs, f));
  }
}
