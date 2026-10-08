#!/usr/bin/env bash
# Installs yt-dlp's standalone binary for this OS and CPU into <dir> (default
# /usr/local/bin), using sudo only if <dir> isn't writable. The standalone
# binary bundles the JS challenge solver scripts; a JS runtime (deno) must be
# on PATH to run them. Linux (x86_64, aarch64) and macOS.
# Usage: install-ytdlp.sh [<dir>]
set -euo pipefail
dir="${1:-/usr/local/bin}"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) asset=yt-dlp_linux ;;
  Linux/aarch64 | Linux/arm64) asset=yt-dlp_linux_aarch64 ;;
  Darwin/*) asset=yt-dlp_macos ;;
  *)
    echo "No yt-dlp binary for $(uname -s) $(uname -m); try pip install yt-dlp" >&2
    exit 1
    ;;
esac

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset" -o "$tmp"
chmod 755 "$tmp"
if mkdir -p "$dir" 2> /dev/null && [ -w "$dir" ]; then
  install -m 755 "$tmp" "$dir/yt-dlp"
else
  sudo mkdir -p "$dir"
  sudo install -m 755 "$tmp" "$dir/yt-dlp"
fi
echo "Installed yt-dlp $("$dir/yt-dlp" --version) to $dir/yt-dlp"
command -v deno > /dev/null || echo "deno is not on PATH; yt-dlp needs it to solve YouTube's JS challenges" >&2
