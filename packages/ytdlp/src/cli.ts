#!/usr/bin/env tsx
// The `ytdlp` CLI: this package's API for shell scripts and workflows, such as
// fetch-youtube-audio.yml. yt-dlp's own stdout goes to stdout; progress,
// routes and errors go to stderr.
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { egressPaths, installWarpAndTor } from "./daemons";
import { runWithEgress } from "./egress";
import { parseRoutes, routesFromEnv } from "./routes";
import { ensureYtDlpInstalled } from "./run";

const install = defineCommand({
  meta: {
    name: "install",
    description: `Put yt-dlp's standalone binary in the repo's .cache/bin, unless it's on PATH or already there. No sudo.`,
  },
  async run() {
    await ensureYtDlpInstalled();
  },
});

const installEgress = defineCommand({
  meta: {
    name: "install-egress",
    description:
      "Unpack Cloudflare WARP and Tor so the warp and tor routes can run. Linux with apt, and sudo.",
  },
  args: {
    debDir: {
      type: "positional",
      description:
        "Where the .deb files are kept, so a workflow can cache them and skip `apt-get update`",
      required: true,
    },
  },
  async run({ args }) {
    await installWarpAndTor(args.debDir);
  },
});

/**
 * Copies WARP's and Tor's logs into `dir`, plus `last-error.txt` holding
 * `error` if there was one.
 */
async function saveLogs(dir: string, error?: string) {
  await mkdir(dir, { recursive: true });
  if (error !== undefined) {
    await writeFile(join(dir, "last-error.txt"), `${error}\n`);
  }
  const { state } = egressPaths();
  const files = await readdir(state).catch(() => []);
  for (const f of files.filter((f) => f.endsWith(".log"))) {
    await copyFile(join(state, f), join(dir, f));
  }
}

const run = defineCommand({
  meta: {
    name: "run",
    description:
      "Run yt-dlp with the arguments after `--`, through each route in turn until one gets through. Installs yt-dlp first if needed.",
  },
  args: {
    routes: {
      type: "string",
      description:
        "Comma-separated routes to try in order: direct, warp, tor or a proxy URL. Default: $YOUTUBE_EGRESS, else direct,warp,tor.",
    },
    logs: {
      type: "string",
      description:
        "Directory to copy WARP's and Tor's logs into when done, plus last-error.txt with the error on failure",
    },
  },
  async run({ args }) {
    const ytDlpArgs = args._;
    if (ytDlpArgs.length === 0) {
      throw new Error("Pass yt-dlp's arguments after `--`");
    }
    const routes = args.routes ? parseRoutes(args.routes) : routesFromEnv();
    let error: string | undefined;
    try {
      await ensureYtDlpInstalled();
      const { stdout, route } = await runWithEgress(ytDlpArgs, {
        routes,
      });
      process.stdout.write(stdout);
      console.error(`yt-dlp: got through via ${route}`);
    } catch (e) {
      error = (e as Error).message;
      console.error(error);
      process.exitCode = 1;
    } finally {
      if (args.logs) await saveLogs(args.logs, error);
    }
  },
});

await runMain(
  defineCommand({
    meta: {
      name: "ytdlp",
      description:
        "Run yt-dlp from any machine, routed past YouTube's block on datacenter IPs through Cloudflare WARP or Tor",
    },
    subCommands: { install, "install-egress": installEgress, run },
  }),
);
