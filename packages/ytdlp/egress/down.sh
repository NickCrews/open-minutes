#!/usr/bin/env bash
# Stops the WARP and Tor that up.sh started, found by their PID files, and
# deletes Tor's data directory. Logs stay in the state directory.
# Usage: down.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"

stop_tor
rm -rf "$state/tor" "$state/tor.port"
stop_warp
