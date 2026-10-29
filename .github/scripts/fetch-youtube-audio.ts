// Fetches one YouTube video's metadata and speech-quality audio with
// youtube() from @open-minutes/youtube, into <output dir>/metadata.json and
// <output dir>/speech.webm.
// Usage: pnpm exec vpx .github/scripts/fetch-youtube-audio.ts <video id> <output dir>
//
// The requests go out through runWithEgress's routes (YOUTUBE_EGRESS; the
// fetch-youtube-audio workflow sets warp,tor, since YouTube refuses GitHub's
// IPs). Expects packages/ytdlp/egress/install.sh to have run; see
// docs/research/youtube-in-ci.md.
//
// On failure, <output dir>/logs/last-error.txt says why, and WARP's and Tor's
// logs are copied beside it.
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { egressPaths } from "@open-minutes/ytdlp";
import { metadataToJson, youtube } from "@open-minutes/youtube";

const [id, out] = process.argv.slice(2);
if (!id || !out) {
  console.error("Usage: fetch-youtube-audio.ts <video id> <output dir>");
  process.exit(2);
}
const logs = join(out, "logs");
await mkdir(logs, { recursive: true });

try {
  const yt = youtube();
  const metadata = await yt.getMetadata(id);
  await writeFile(join(out, "metadata.json"), metadataToJson(metadata));
  await yt.downloadAudio(id, join(out, "speech.webm"));
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
