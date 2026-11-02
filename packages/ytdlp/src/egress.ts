import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isBlockedExit } from "./blocked";
import {
  type EgressPaths,
  type Service,
  canInstall,
  down,
  egressPaths,
  installWarpAndTor,
  rotate,
  unavailableReason,
  up,
} from "./daemons";
import { acquireLock } from "./lock";
import { type Route, routesFromEnv } from "./routes";
import { YtDlpError, run } from "./run";

/** What happened on a route that didn't work. */
export type RouteOutcome =
  | {
      route: Route;
      outcome: "blocked";
      /** yt-dlp's last error through this route. */
      error: string;
    }
  | {
      route: Route;
      outcome: "unavailable";
      /** Why it can't run here, and what to install. */
      reason: string;
    };

/** No route got yt-dlp through. `routes` says what happened on each. */
export class EgressError extends Error {
  constructor(readonly routes: readonly RouteOutcome[]) {
    super(
      routes.length
        ? [
            "yt-dlp got through on no route:",
            ...routes.map((r) =>
              r.outcome === "blocked"
                ? `  ${r.route}: blocked: ${r.error}`
                : `  ${r.route}: unavailable: ${r.reason}`,
            ),
          ].join("\n")
        : "yt-dlp has no routes to try",
    );
    this.name = "EgressError";
  }
}

/** Options for one yt-dlp run through the routes. */
export interface RunOptions {
  /**
   * Whether an error means the route was refused or unreachable, so the next
   * exit or route should be tried. Any other error is thrown at once.
   * Defaults to {@link isBlockedExit}.
   */
  isBlocked?: (error: YtDlpError) => boolean;
  /** Runs before each attempt, e.g. to clear a partial download. */
  beforeAttempt?: () => unknown;
  /** Kills yt-dlp and rejects with its reason, trying no more routes. */
  signal?: AbortSignal;
}

export interface EgressOptions {
  /** Tried in order. Defaults to {@link routesFromEnv}. */
  routes?: readonly Route[];
  /**
   * How long to wait for another process's manager to close before starting
   * a daemon. Default 30 minutes.
   */
  lockTimeoutMs?: number;
  /** Progress lines. Defaults to stderr. */
  log?: (line: string) => void;
  /**
   * When set, a `warp` or `tor` route that isn't unpacked is installed with
   * {@link installWarpAndTor} before it's started, if this machine can
   * install them (Linux with apt, and root or passwordless sudo). By default
   * nothing is installed.
   */
  install?: {
    /**
     * Where the .deb files are kept, so they can be cached between runs.
     * Default: `debs` in the egress state directory.
     */
    debDir?: string;
  };
}

export interface EgressResult {
  stdout: string;
  stderr: string;
  /** The route that worked. */
  route: Route;
}

/** yt-dlp run through a set of routes, with the daemons they need. */
export interface Egress {
  /**
   * Runs yt-dlp with `args` through each route in turn, as
   * {@link runWithEgress} does. Daemons stay up between runs, and a route
   * found blocked or unavailable is skipped until {@link Egress.close}.
   */
  run(args: readonly string[], options?: RunOptions): Promise<EgressResult>;
  /** Stops the daemons this started and releases the machine's lock. */
  close(): Promise<void>;
}

/**
 * yt-dlp retries a broken connection 10 times by default, about a minute.
 * Through a proxy, a route that fails mid-download rarely recovers, and a new
 * exit is the better retry.
 */
const PROXIED_ARGS = ["--retries", "2", "--fragment-retries", "2"];

/** Attempts per daemon route: its first exit, then up to two new ones. */
const DAEMON_ATTEMPTS = 3;

function isService(route: Route): route is Service {
  return route === "warp" || route === "tor";
}

/**
 * A manager for a process that runs yt-dlp many times, like a scout. Does no
 * I/O until {@link Egress.run} is called. `direct` and proxy URL routes need
 * nothing started. Before starting a daemon it takes a lock file in the
 * egress state directory, held until {@link Egress.close}, so only one
 * manager on a machine starts or rotates WARP and Tor: rotating an exit
 * changes it for everyone using it.
 */
export function egress({
  routes = routesFromEnv(),
  lockTimeoutMs = 30 * 60_000,
  log = (line) => console.error(line),
  install,
}: EgressOptions = {}): Egress {
  const paths: EgressPaths = egressPaths();
  /** Routes that didn't work, skipped until close(). */
  const skipped = new Map<Route, RouteOutcome>();
  /** The proxy URL of each daemon that's up. */
  const proxies = new Map<Service, string>();
  /** Whether up.sh ran, so down.sh has something to stop. */
  let startedAny = false;
  let release: (() => Promise<void>) | undefined;
  /** Whether installWarpAndTor has been tried, so it runs at most once. */
  let installTried = false;

  // Starting, rotating and stopping daemons happen one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }

  /** Takes the machine's lock, unless this manager holds it already. */
  async function lock() {
    if (release) return;
    await mkdir(paths.state, { recursive: true });
    release = await acquireLock(join(paths.state, "manager.lock"), {
      timeoutMs: lockTimeoutMs,
      log,
    });
  }

  /** The service's proxy URL, starting it if needed, or why it can't run. */
  function start(service: Service): Promise<string | RouteOutcome> {
    return serially(async () => {
      const running = proxies.get(service);
      if (running) return running;
      const unavailable = (reason: string): RouteOutcome => ({
        route: service,
        outcome: "unavailable",
        reason,
      });
      let reason = await unavailableReason(service, paths);
      if (reason && install && !installTried && canInstall()) {
        installTried = true;
        await lock();
        log(`yt-dlp: ${reason}; installing WARP and Tor`);
        try {
          await installWarpAndTor(install.debDir ?? join(paths.state, "debs"), {
            root: paths.root,
          });
        } catch (error) {
          return unavailable((error as Error).message);
        }
        reason = await unavailableReason(service, paths);
      }
      if (reason) return unavailable(reason);
      await lock();
      log(`yt-dlp: starting ${service}`);
      startedAny = true;
      try {
        const proxy = await up(service, paths);
        proxies.set(service, proxy);
        return proxy;
      } catch (error) {
        return unavailable((error as Error).message);
      }
    });
  }

  /** A new exit for `service`, or undefined if rotating failed. */
  function newExit(service: Service): Promise<string | undefined> {
    return serially(async () => {
      try {
        const proxy = await rotate(service, paths);
        proxies.set(service, proxy);
        return proxy;
      } catch (error) {
        log(`yt-dlp: ${(error as Error).message}`);
        return undefined;
      }
    });
  }

  let closed = false;

  return {
    async run(args, { isBlocked = isBlockedExit, beforeAttempt, signal } = {}) {
      if (closed) throw new Error("This yt-dlp egress manager is closed");

      /** One attempt; the error if the route was blocked. */
      async function attempt(route: Route, proxy?: string) {
        signal?.throwIfAborted();
        await beforeAttempt?.();
        try {
          const out = await run(
            proxy ? ["--proxy", proxy, ...PROXIED_ARGS, ...args] : args,
            { signal },
          );
          return { ...out, route };
        } catch (error) {
          if (!(error instanceof YtDlpError) || !isBlocked(error)) throw error;
          log(`yt-dlp: blocked via ${route}: ${error.message}`);
          return error;
        }
      }

      async function tryRoute(
        route: Route,
      ): Promise<EgressResult | RouteOutcome> {
        const blocked = (error: YtDlpError): RouteOutcome => ({
          route,
          outcome: "blocked",
          error: error.message,
        });
        if (!isService(route)) {
          const result = await attempt(
            route,
            route === "direct" ? undefined : route,
          );
          return result instanceof YtDlpError ? blocked(result) : result;
        }
        const started = await start(route);
        if (typeof started !== "string") return started;
        let proxy = started;
        let last: YtDlpError | undefined;
        for (let n = 0; n < DAEMON_ATTEMPTS; n++) {
          if (n > 0) {
            const next = await newExit(route);
            if (!next) break;
            proxy = next;
          }
          const result = await attempt(route, proxy);
          if (!(result instanceof YtDlpError)) return result;
          last = result;
        }
        // The first attempt always runs, so `last` is set.
        return blocked(last!);
      }

      const outcomes: RouteOutcome[] = [];
      for (const route of routes) {
        signal?.throwIfAborted();
        const outcome = skipped.get(route) ?? (await tryRoute(route));
        if ("stdout" in outcome) return outcome;
        skipped.set(route, outcome);
        outcomes.push(outcome);
      }
      throw new EgressError(outcomes);
    },

    close() {
      closed = true;
      return serially(async () => {
        if (startedAny) {
          await down(paths).catch((error: Error) =>
            log(`yt-dlp: ${error.message}`),
          );
          proxies.clear();
          startedAny = false;
        }
        await release?.();
        release = undefined;
      });
    },
  };
}

/**
 * Runs yt-dlp with `args` through each route in turn (by default
 * `YOUTUBE_EGRESS`, else `direct,warp,tor`), adding `--proxy` for a route
 * that has one, and resolves with yt-dlp's output and the route that worked.
 *
 * `direct` is tried first, so on a home connection nothing starts. The next
 * route is tried only when `isBlocked` says the exit was refused or
 * unreachable; any other error is thrown at once. WARP and Tor are started
 * when first reached and get up to two new exits each. A route that can't
 * run here (not installed, not Linux, no root) is skipped, unless
 * `options.install` lets it be installed. Whatever this
 * started is stopped before it returns. When no route works, rejects with an
 * {@link EgressError}.
 */
export async function runWithEgress(
  args: readonly string[],
  {
    isBlocked,
    beforeAttempt,
    signal,
    ...options
  }: EgressOptions & RunOptions = {},
): Promise<EgressResult> {
  const manager = egress(options);
  try {
    return await manager.run(args, { isBlocked, beforeAttempt, signal });
  } finally {
    await manager.close();
  }
}
