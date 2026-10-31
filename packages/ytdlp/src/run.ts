import { execFile, spawn, spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * The repo's gitignored `.cache/bin`, where {@link ensureYtDlpInstalled} puts
 * yt-dlp when it isn't on PATH.
 */
export const BIN_DIR = join(PACKAGE_DIR, "..", "..", ".cache", "bin");

/** `process.env` with {@link BIN_DIR} last on PATH, so a yt-dlp on PATH wins. */
function ytDlpEnv(): NodeJS.ProcessEnv {
  const path = [process.env.PATH, BIN_DIR].filter(Boolean).join(delimiter);
  return { ...process.env, PATH: path };
}

/**
 * Lets yt-dlp solve YouTube's JS challenges with the node running this, so
 * deno is optional. yt-dlp still prefers deno when it's on PATH, since deno
 * sandboxes the player JS more tightly. Needs node 22+.
 */
const JS_RUNTIME_ARGS = ["--js-runtimes", `node:${process.execPath}`];

/** The last `ERROR:` line in yt-dlp's stderr, if any. */
function lastErrorLine(stderr: string): string | undefined {
  return stderr
    .split("\n")
    .filter((l) => l.startsWith("ERROR:"))
    .at(-1);
}

/** A failed yt-dlp run. The message is yt-dlp's last `ERROR:` line. */
export class YtDlpError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stdout: string,
    readonly stderr: string,
    cause: Error,
  ) {
    const notFound = (cause as NodeJS.ErrnoException).code === "ENOENT";
    super(
      notFound
        ? `yt-dlp is not on PATH or in ${BIN_DIR}; call ensureYtDlpInstalled() first`
        : (lastErrorLine(stderr) ?? cause.message),
      { cause },
    );
    this.name = "YtDlpError";
  }
}

/**
 * Runs yt-dlp once with `args`, with no proxy logic. Rejects with a
 * {@link YtDlpError} carrying yt-dlp's stdout and stderr, or with `signal`'s
 * reason once it aborts, which kills yt-dlp.
 */
export function run(
  args: readonly string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      [...JS_RUNTIME_ARGS, ...args],
      // A busy channel's flat playlist runs to several MB.
      { maxBuffer: 100 * 1024 * 1024, env: ytDlpEnv(), signal },
      (error, stdout, stderr) => {
        if (signal?.aborted) reject(signal.reason);
        else if (error) reject(new YtDlpError(args, stdout, stderr, error));
        else resolve({ stdout, stderr });
      },
    );
  });
}

let installing: Promise<void> | undefined;

/**
 * Puts yt-dlp's standalone binary in {@link BIN_DIR} (no sudo; Linux and
 * macOS). A no-op when yt-dlp is already on PATH or there. Installs nothing
 * else: see `installWarpAndTor` for the egress daemons.
 */
export function ensureYtDlpInstalled(): Promise<void> {
  installing ??= install().catch((error: unknown) => {
    installing = undefined;
    throw error;
  });
  return installing;
}

async function install() {
  const found = !spawnSync("yt-dlp", ["--version"], {
    stdio: "ignore",
    env: ytDlpEnv(),
  }).error;
  if (found) return;
  console.error(`yt-dlp is not on PATH; installing it into ${BIN_DIR}`);
  await runScript(join(PACKAGE_DIR, "install-ytdlp.sh"), [BIN_DIR]);
}

/**
 * Runs one of this package's scripts with its output on stderr, so callers'
 * stdout stays machine-readable.
 */
export function runScript(path: string, args: readonly string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(path, args, { stdio: ["ignore", 2, 2] });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${path} exited with code ${code}`)),
    );
  });
}
