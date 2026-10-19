#!/usr/bin/env bash
# Gives a proxy started by up.sh a new exit, and prints its URL: for WARP, a new
# registration (which often keeps the same exit IP); for Tor, a restart with a
# fresh data directory, so a fresh circuit.
# Usage: rotate.sh warp|tor
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"

case "${1:-}" in
  warp)
    warp_allowed
    new_warp_exit
    warp_proxy
    ;;
  tor)
    start_tor
    wait_for_tor || { echo "Tor did not bootstrap; see $state/tor.log" >&2; exit 1; }
    tor_proxy
    ;;
  *) echo "Usage: rotate.sh warp|tor" >&2; exit 2 ;;
esac
