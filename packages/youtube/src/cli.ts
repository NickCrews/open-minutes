#!/usr/bin/env tsx
// The `youtube` CLI, for shell scripts and workflows such as
// fetch-youtube-audio.yml. Progress and errors go to stderr; results go to
// stdout.
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { egressPaths, parseRoutes } from "@open-minutes/ytdlp";
import { fetchVideo, youtubeConfigFromEnv } from ".";

/**
 * Copies WARP's and Tor's logs into `dir`, plus `last-error.txt` holding
 * `error` if there was one. Creates `dir` only if there's something to put in
 * it.
 */
async function saveLogs(dir: string, error?: string) {
  const { state } = egressPaths();
  const logs = (await readdir(state).catch(() => [])).filter((f) =>
    f.endsWith(".log"),
  );
  if (!logs.length && error === undefined) return;
  await mkdir(dir, { recursive: true });
  if (error !== undefined) {
    await writeFile(join(dir, "last-error.txt"), `${error}\n`);
  }
  for (const f of logs) await copyFile(join(state, f), join(dir, f));
}

const fetch = defineCommand({
  meta: {
    name: "fetch",
    description:
      "Download a video's original audio to <dir>/audio.webm and yt-dlp's metadata to <dir>/info.json (minus its stream URLs). " +
      "Goes direct first; if YouTube refuses, installs (on Linux with apt and sudo), starts and then stops WARP or Tor. " +
      "On failure, <dir>/logs/last-error.txt says why, beside WARP's and Tor's logs.",
  },
  args: {
    video: {
      type: "positional",
      description: "A video ID or watch URL",
      required: true,
    },
    dir: {
      type: "positional",
      description: "Where to write audio.webm and info.json",
      required: true,
    },
    routes: {
      type: "string",
      description:
        "Comma-separated routes to try in order: direct, warp, tor or a proxy URL. Default: $YOUTUBE_EGRESS, else direct,warp,tor.",
    },
    install: {
      type: "boolean",
      description:
        "Install WARP and Tor if a route needs them (--no-install to skip)",
      default: true,
    },
    debs: {
      type: "string",
      description:
        "Where WARP's and Tor's .deb files are kept when installing, so they can be cached. Default: in the egress state directory.",
    },
  },
  async run({ args }) {
    const config = youtubeConfigFromEnv();
    if (args.routes) config.routes = parseRoutes(args.routes);
    if (args.install) config.installEgress = { debDir: args.debs };
    let error: string | undefined;
    try {
      const { audio, info, route } = await fetchVideo(
        args.video,
        args.dir,
        config,
      );
      console.error(`Fetched via ${route}`);
      console.log(JSON.stringify({ audio, info, route }));
    } catch (e) {
      error = (e as Error).message;
      console.error(error);
      process.exitCode = 1;
    } finally {
      await saveLogs(join(args.dir, "logs"), error);
    }
  },
});

await runMain(
  defineCommand({
    meta: {
      name: "youtube",
      description: "Fetch meetings published on YouTube",
    },
    subCommands: { fetch },
  }),
);
