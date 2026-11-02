/** A proxy URL yt-dlp's `--proxy` takes, such as `socks5://127.0.0.1:9050`. */
export type ProxyUrl = `${string}://${string}`;

/**
 * One way out to YouTube:
 * - `direct`: no proxy.
 * - `warp`: Cloudflare WARP in proxy mode, started by the egress scripts.
 * - `tor`: Tor, started by the egress scripts.
 * - a proxy URL, used as is and never started or rotated.
 */
export type Route = "direct" | "warp" | "tor" | ProxyUrl;

/** The routes tried when `YOUTUBE_EGRESS` is unset. */
export const DEFAULT_ROUTES: readonly Route[] = ["direct", "warp", "tor"];

/** Parses a comma-separated list of routes, such as `warp,tor`. */
export function parseRoutes(spec: string): Route[] {
  return spec
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      if (r === "direct" || r === "warp" || r === "tor" || isProxyUrl(r)) {
        return r;
      }
      throw new Error(
        `Unknown yt-dlp route "${r}" in "${spec}": use direct, warp, tor or a proxy URL such as socks5://127.0.0.1:9050`,
      );
    });
}

function isProxyUrl(r: string): r is ProxyUrl {
  return /^[a-z][a-z0-9+.-]*:\/\/./i.test(r);
}

/**
 * The routes in `YOUTUBE_EGRESS` (comma-separated), or
 * {@link DEFAULT_ROUTES} when it's unset or empty.
 */
export function routesFromEnv(env = process.env): Route[] {
  const routes = parseRoutes(env.YOUTUBE_EGRESS ?? "");
  return routes.length ? routes : [...DEFAULT_ROUTES];
}
