#!/usr/bin/env bash
# Starts Cloudflare WARP (in proxy mode) and Tor, unpacked by install.sh, and
# prints one yt-dlp proxy URL per line, WARP's first:
#   export YOUTUBE_PROXY="$(packages/youtube/egress/up.sh | paste -sd,)"
# Usage: up.sh [warp] [tor]
#
# Returns once each proxy is ready. With no arguments it starts both, skipping
# WARP (with a note) where it isn't unpacked or a system WARP is running; named
# explicitly, a service that can't start is an error. rotate.sh gives a proxy a
# new exit; down.sh stops them. See lib.sh for the environment variables.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"

want_warp=0 want_tor=0 optional_warp=0
if [ $# = 0 ]; then
  want_warp=1 want_tor=1 optional_warp=1
fi
for service in "$@"; do
  case "$service" in
    warp) want_warp=1 ;;
    tor) want_tor=1 ;;
    *) echo "Usage: up.sh [warp] [tor]" >&2; exit 2 ;;
  esac
done

if [ "$want_warp" = 1 ] && ! warp_allowed; then
  [ "$optional_warp" = 1 ] || exit 1
  want_warp=0
fi

# Tor first, so its bootstrap overlaps WARP's start.
if [ "$want_tor" = 1 ]; then start_tor; fi
if [ "$want_warp" = 1 ]; then
  start_warp || echo "warp-svc did not report ready; trying anyway" >&2
  connect_warp || { echo "WARP did not connect; see $state/warp-svc.log" >&2; exit 1; }
  warp_proxy
fi
if [ "$want_tor" = 1 ]; then
  wait_for_tor || { echo "Tor did not bootstrap; see $state/tor.log" >&2; exit 1; }
  tor_proxy
fi
