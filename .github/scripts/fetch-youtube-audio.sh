#!/usr/bin/env bash
# Downloads the audio of one YouTube video on a GitHub-hosted runner, plus
# yt-dlp's metadata for it beside the audio (<output>.info.json, with the
# output's extension replaced).
# Usage: fetch-youtube-audio.sh <video id> <output file>
#
# YouTube refuses requests from GitHub's (Microsoft) IP ranges, so the request
# goes out through Cloudflare WARP, and then Tor if WARP keeps failing. Both
# share exit IPs with many other users and YouTube flags some of those IPs, so
# each retry asks for a new exit: a new WARP registration or a new Tor circuit.
# A new WARP registration often keeps the same exit, so Tor is what recovers
# from a flagged one. Expects install-youtube-egress.sh to have run; see
# docs/research/youtube-in-ci.md.
#
# The output is YouTube's Opus audio as-is (format 251, ~50 MB per hour);
# encode-speech-audio.sh then shrinks it for the object store.
set -u
id="$1"
out="$2"
logs="$(dirname "$out")/logs"
mkdir -p "$logs"

# Hostnames are resolved on the runner (socks5, not socks5h). The runner has
# no IPv6, so WARP then exits over IPv4; YouTube refused WARP's IPv6 exits more
# often in testing.
#
# WARP and Tor are unpacked here, not installed, so they're started by hand
# and find their libraries through LD_LIBRARY_PATH.
root=/opt/youtube-egress
libs="$root/usr/lib/$(uname -m)-linux-gnu"

warp() { "$root/bin/warp-cli" --accept-tos "$@"; }

start_warp() {
  sudo env LD_LIBRARY_PATH="$libs" "$root/bin/warp-svc" > "$logs/warp-svc.log" 2>&1 &
  for _ in $(seq 50); do
    warp status > /dev/null 2>&1 && break
    sleep 0.2
  done
  # ~3 s after starting, warp-svc finishes scanning the network and restarts
  # its tunnel, dropping every connection through it. Connecting before then
  # fails partway, so wait for that (with a timeout, in case it never logs it).
  for _ in $(seq 50); do
    grep -q NetworkInfoChanged "$logs/warp-svc.log" && return 0
    sleep 0.2
  done
  warp status > /dev/null 2>&1
}

new_warp_exit() {
  warp disconnect > /dev/null 2>&1 || true
  warp registration delete > /dev/null 2>&1 || true
  warp registration new > /dev/null && warp mode proxy > /dev/null && warp connect > /dev/null || return 1
  # The proxy accepts connections a few seconds before it can route them, so
  # wait until traffic through it actually leaves through WARP.
  for _ in $(seq 60); do
    curl -s --max-time 2 --proxy socks5h://127.0.0.1:40000 \
      https://www.cloudflare.com/cdn-cgi/trace | grep -q '^warp=on' && return 0
    sleep 0.5
  done
  return 1
}

# A fresh Tor process builds a fresh circuit. Tor takes ~10 s to bootstrap,
# so the first one starts in the background before WARP is tried.
start_tor() {
  pkill -x tor || true
  rm -rf "$RUNNER_TEMP/tor"
  LD_LIBRARY_PATH="$libs" "$root/usr/bin/tor" --SocksPort 9050 \
    --DataDirectory "$RUNNER_TEMP/tor" > "$logs/tor.log" 2>&1 &
}

wait_for_tor() {
  for _ in $(seq 60); do
    grep -q "Bootstrapped 100%" "$logs/tor.log" && return 0
    sleep 1
  done
  return 1
}

attempt() {
  local route="$1" proxy="$2" n="$3"
  local log="$logs/attempt-$n-$route.log"
  echo "attempt $n via $route, exit $(curl -s --max-time 5 --proxy "$proxy" https://www.cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p')"
  # Few retries: a route that fails mid-download rarely recovers, and the
  # next attempt gets a new one.
  if yt-dlp -v -f "bestaudio[ext=webm]" --no-playlist --write-info-json --proxy "$proxy" \
      --retries 2 --fragment-retries 2 \
      -o "$out" "https://www.youtube.com/watch?v=$id" > "$log" 2>&1; then
    echo "downloaded via $route on attempt $n"
    return 0
  fi
  grep -E '^ERROR' "$log" | tail -1 | tee "$logs/last-error.txt"
  return 1
}

n=0
start_tor
start_warp || echo "warp-svc did not start"
for _ in 1 2 3; do
  n=$((n + 1))
  new_warp_exit && attempt warp socks5://127.0.0.1:40000 "$n" && exit 0
done
n=$((n + 1))
wait_for_tor && attempt tor socks5://127.0.0.1:9050 "$n" && exit 0
for _ in 1 2; do
  n=$((n + 1))
  start_tor && wait_for_tor && attempt tor socks5://127.0.0.1:9050 "$n" && exit 0
done
echo "all $n attempts failed"
exit 1
