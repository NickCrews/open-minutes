# shellcheck shell=bash
# Helpers for up.sh, rotate.sh and down.sh: start, re-exit and stop Cloudflare
# WARP (in proxy mode) and Tor as SOCKS proxies for yt-dlp. See
# docs/research/youtube-in-ci.md for why, and for what the waits below are for.
#
# YOUTUBE_EGRESS_ROOT  where install.sh unpacked WARP and Tor
#                      (default /opt/youtube-egress). Tor is taken from PATH
#                      if it isn't there; WARP never is (see warp_allowed).
# YOUTUBE_EGRESS_STATE PID files, logs and Tor's data directory
#                      (default $TMPDIR/youtube-egress)
# YOUTUBE_EGRESS_FORCE 1 to use WARP even though a system warp-svc is running

root="${YOUTUBE_EGRESS_ROOT:-/opt/youtube-egress}"
state="${YOUTUBE_EGRESS_STATE:-${TMPDIR:-/tmp}/youtube-egress}"
mkdir -p "$state"

# WARP and Tor are unpacked, not installed, so they're started by hand and find
# their libraries through LD_LIBRARY_PATH.
libs="$root/usr/lib/$(uname -m)-linux-gnu"

# Hostnames are resolved on this machine (socks5, not socks5h). Without IPv6
# here (GitHub's runners have none), WARP then exits over IPv4; YouTube refused
# WARP's IPv6 exits more often in testing.
warp_proxy() { echo socks5://127.0.0.1:40000; }
tor_proxy() { echo "socks5://127.0.0.1:$(cat "$state/tor.port")"; }

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

warp() { "$root/bin/warp-cli" --accept-tos "$@"; }

# Whether WARP may be started, re-registered and stopped here. A warp-svc not
# started from $root is a system install (the WARP desktop app, say), and
# rotating would delete its registration.
warp_allowed() {
  if [ ! -x "$root/bin/warp-svc" ]; then
    echo "WARP is not unpacked in $root; run install.sh" >&2
    return 1
  fi
  [ "${YOUTUBE_EGRESS_FORCE:-}" = 1 ] && return 0
  local pid
  for pid in $(pgrep -x warp-svc); do
    case "$(ps -o args= -p "$pid")" in
      "$root/bin/warp-svc"*) ;;
      *)
        echo "A system warp-svc (PID $pid) is running; leaving WARP alone. Set YOUTUBE_EGRESS_FORCE=1 to use it anyway, which deletes its registration on rotate." >&2
        return 1
        ;;
    esac
  done
}

start_warp() {
  # Already running (from an earlier up.sh, or a forced system one).
  warp status > /dev/null 2>&1 && return 0
  # sh records warp-svc's own PID, not sudo's, for down.sh.
  # shellcheck disable=SC2016 # expanded by that sh
  as_root sh -c 'echo $$ > "$1"; shift; exec env "$@"' sh "$state/warp-svc.pid" \
    LD_LIBRARY_PATH="$libs" "$root/bin/warp-svc" > "$state/warp-svc.log" 2>&1 &
  for _ in $(seq 50); do
    warp status > /dev/null 2>&1 && break
    sleep 0.2
  done
  # ~3 s after starting, warp-svc finishes scanning the network and restarts
  # its tunnel, dropping every connection through it. Connecting before then
  # fails partway, so wait for that (with a timeout, in case it never logs it).
  for _ in $(seq 50); do
    grep -q NetworkInfoChanged "$state/warp-svc.log" && return 0
    sleep 0.2
  done
  warp status > /dev/null 2>&1
}

connect_warp() {
  warp registration show > /dev/null 2>&1 || warp registration new > /dev/null || return 1
  warp mode proxy > /dev/null && warp connect > /dev/null || return 1
  # The proxy accepts connections a few seconds before it can route them, so
  # wait until traffic through it actually leaves through WARP.
  for _ in $(seq 60); do
    curl -s --max-time 2 --proxy socks5h://127.0.0.1:40000 \
      https://www.cloudflare.com/cdn-cgi/trace | grep -q '^warp=on' && return 0
    sleep 0.5
  done
  return 1
}

# A new registration often keeps the same exit IP; Tor is what recovers from a
# flagged one.
new_warp_exit() {
  warp disconnect > /dev/null 2>&1 || true
  warp registration delete > /dev/null 2>&1 || true
  connect_warp
}

stop_warp() {
  local pid
  pid=$(cat "$state/warp-svc.pid" 2>/dev/null) || return 0
  as_root kill "$pid" 2>/dev/null || true
  for _ in $(seq 50); do
    ps -p "$pid" > /dev/null || break
    sleep 0.2
  done
  rm -f "$state/warp-svc.pid"
}

tor_bin() {
  if [ -x "$root/usr/bin/tor" ]; then echo "$root/usr/bin/tor"; else command -v tor; fi
}

port_in_use() { (echo > "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }

# A fresh Tor process builds a fresh circuit. Tor takes ~10 s to bootstrap, so
# this returns at once; wait_for_tor waits. It gets its own SOCKS port and data
# directory, so it never collides with a Tor already running here: 9050 unless
# something else has it.
start_tor() {
  local tor port=
  tor=$(tor_bin) || { echo "Tor is neither in $root nor on PATH" >&2; return 1; }
  stop_tor
  rm -rf "$state/tor"
  for p in $(seq 9050 2 9070); do
    port_in_use "$p" || { port=$p; break; }
  done
  [ -n "$port" ] || { echo "No free port for Tor in 9050-9070" >&2; return 1; }
  echo "$port" > "$state/tor.port"
  LD_LIBRARY_PATH="$libs" "$tor" --SocksPort "$port" \
    --DataDirectory "$state/tor" > "$state/tor.log" 2>&1 &
  echo $! > "$state/tor.pid"
}

wait_for_tor() {
  for _ in $(seq 60); do
    grep -q "Bootstrapped 100%" "$state/tor.log" && return 0
    sleep 1
  done
  return 1
}

stop_tor() {
  local pid
  pid=$(cat "$state/tor.pid" 2>/dev/null) || return 0
  if [ "$(ps -o comm= -p "$pid")" = tor ]; then
    kill "$pid"
    for _ in $(seq 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
  fi
  rm -f "$state/tor.pid"
}
