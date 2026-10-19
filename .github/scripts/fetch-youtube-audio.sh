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
# from a flagged one. Expects packages/youtube/egress/install.sh to have run;
# see docs/research/youtube-in-ci.md.
#
# The output is YouTube's Opus audio as-is (format 251, ~50 MB per hour);
# encode-speech-audio.sh then shrinks it for the object store.
set -u
id="$1"
out="$2"
logs="$(dirname "$out")/logs"
mkdir -p "$logs"
egress="$(cd "$(dirname "$0")/../../packages/youtube/egress" && pwd)"
export YOUTUBE_EGRESS_STATE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/youtube-egress"
mkdir -p "$YOUTUBE_EGRESS_STATE"
# WARP's and Tor's logs go up with the attempts' on failure.
trap 'cp "$YOUTUBE_EGRESS_STATE"/*.log "$logs"/ 2> /dev/null' EXIT

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

# up.sh starts Tor before WARP, so Tor's ~10 s bootstrap overlaps WARP's start,
# and returns once both are ready. WARP comes up freshly registered, so the
# first attempt needs no rotate.
if proxies=$("$egress/up.sh" warp tor); then
  warp=$(echo "$proxies" | sed -n 1p)
  tor=$(echo "$proxies" | sed -n 2p)
  fresh=1
else
  echo "WARP or Tor did not come up"
  warp=socks5://127.0.0.1:40000
  tor=$("$egress/up.sh" tor) || tor=
  fresh=0
fi
n=0
for _ in 1 2 3; do
  n=$((n + 1))
  if [ "$fresh" = 1 ] || "$egress/rotate.sh" warp > /dev/null; then
    attempt warp "$warp" "$n" && exit 0
  fi
  fresh=0
done
n=$((n + 1))
[ -n "$tor" ] && attempt tor "$tor" "$n" && exit 0
for _ in 1 2; do
  n=$((n + 1))
  tor=$("$egress/rotate.sh" tor) && attempt tor "$tor" "$n" && exit 0
done
echo "all $n attempts failed"
exit 1
