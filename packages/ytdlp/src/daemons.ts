import { execFile, spawnSync } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScript } from "./run";

/**
 * The bash scripts that install, start, rotate and stop WARP and Tor. They
 * carry timing learned on GitHub's runners; see lib.sh and
 * docs/research/youtube-in-ci.md.
 */
const EGRESS_DIR = fileURLToPath(new URL("../egress", import.meta.url));

/** A route this package starts and rotates itself. */
export type Service = "warp" | "tor";

/** Where the egress scripts keep WARP and Tor, and their state. */
export interface EgressPaths {
  /** Where `installWarpAndTor` unpacks WARP and Tor. */
  root: string;
  /** PID files, logs, Tor's data directory and the manager's lock. */
  state: string;
}

/**
 * {@link EgressPaths} from `YOUTUBE_EGRESS_ROOT` (default
 * `/opt/youtube-egress`) and `YOUTUBE_EGRESS_STATE` (default
 * `$TMPDIR/youtube-egress`), the variables the scripts read.
 */
export function egressPaths(env = process.env): EgressPaths {
  return {
    root: env.YOUTUBE_EGRESS_ROOT || "/opt/youtube-egress",
    state: env.YOUTUBE_EGRESS_STATE || join(tmpdir(), "youtube-egress"),
  };
}

const INSTALL_HINT =
  "run installWarpAndTor (packages/ytdlp/egress/install.sh) on Linux with apt";

async function isExecutable(path: string) {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

function canRunAsRoot() {
  if (process.getuid?.() === 0) return true;
  return spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0;
}

/**
 * Whether {@link installWarpAndTor} can run here: Linux with apt, and root or
 * passwordless sudo.
 */
export function canInstall(): boolean {
  if (process.platform !== "linux") return false;
  if (spawnSync("apt-get", ["--version"], { stdio: "ignore" }).error) {
    return false;
  }
  return canRunAsRoot();
}

/** Why `service` can't run on this machine, or null if it may. */
export async function unavailableReason(
  service: Service,
  { root }: EgressPaths,
): Promise<string | null> {
  if (service === "warp") {
    if (process.platform !== "linux") return "WARP runs only on Linux";
    if (!(await isExecutable(join(root, "bin", "warp-svc")))) {
      return `WARP is not unpacked in ${root}; ${INSTALL_HINT}`;
    }
    if (!canRunAsRoot()) {
      return "WARP's daemon runs as root, and sudo needs a password here";
    }
    return null;
  }
  if (await isExecutable(join(root, "usr", "bin", "tor"))) return null;
  if (!spawnSync("tor", ["--version"], { stdio: "ignore" }).error) return null;
  return `Tor is neither in ${root} nor on PATH; ${INSTALL_HINT}, or install tor (apt install tor, brew install tor)`;
}

/** Runs an egress script and resolves with the last line it printed. */
function script(
  name: string,
  args: string[],
  { root, state }: EgressPaths,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      join(EGRESS_DIR, name),
      args,
      {
        env: {
          ...process.env,
          YOUTUBE_EGRESS_ROOT: root,
          YOUTUBE_EGRESS_STATE: state,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`${name} ${args.join(" ")}: ${detail}`));
        } else resolve(stdout.trim().split("\n").at(-1) ?? "");
      },
    );
  });
}

/** Starts `service` and resolves with its proxy URL once it's ready. */
export function up(service: Service, paths: EgressPaths): Promise<string> {
  return script("up.sh", [service], paths);
}

/**
 * Gives `service` a new exit (a new WARP registration, a new Tor circuit) and
 * resolves with its proxy URL.
 */
export function rotate(service: Service, paths: EgressPaths): Promise<string> {
  return script("rotate.sh", [service], paths);
}

/** Stops what {@link up} started. */
export async function down(paths: EgressPaths): Promise<void> {
  await script("down.sh", [], paths);
}

/**
 * Unpacks Cloudflare WARP and Tor into `root` (default `YOUTUBE_EGRESS_ROOT`
 * or `/opt/youtube-egress`) so the `warp` and `tor` routes can run. Needs
 * Linux with apt, and sudo. The .deb files are kept in `debDir`, so a
 * workflow can cache them and skip `apt-get update`.
 */
export function installWarpAndTor(
  debDir: string,
  { root = egressPaths().root }: { root?: string } = {},
): Promise<void> {
  return runScript(join(EGRESS_DIR, "install.sh"), [debDir, root]);
}
