import type { YtDlpError } from "./run";

/**
 * yt-dlp's stderr when YouTube refused the exit (its bot check, a 403 on the
 * watch page, rate limiting) or the exit couldn't be reached (a proxy that
 * won't connect, a connection that dropped or stalled). Either way another
 * route or exit may do better.
 */
const BLOCKED_EXIT =
  /Sign in to confirm you.re not a bot|content isn.t available, try again later|HTTP Error 429|HTTP Error 403|Unable to connect to proxy|Connection refused|Connection reset by peer|timed out/i;

/**
 * Whether `error` means the route was refused or unreachable, so the next
 * route should be tried. Any other error (a private or removed video, a bad
 * URL) is the same from every route.
 */
export function isBlockedExit(error: YtDlpError): boolean {
  return BLOCKED_EXIT.test(error.stderr);
}
