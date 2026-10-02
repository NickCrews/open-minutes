#!/usr/bin/env bash
# Installs what fetch-youtube-audio.sh needs to reach YouTube from a GitHub
# runner: yt-dlp (the standalone binary, which bundles the JS challenge solver
# scripts; deno must be on PATH) and Cloudflare WARP and Tor, unpacked into
# /opt/youtube-egress rather than installed.
# Usage: install-youtube-egress.sh <deb dir>
#
# Installing the cloudflare-warp package with apt pulls in its desktop app's
# dependencies (GTK, WebKit, GStreamer) and takes ~30 s. The daemon and CLI
# need only two TPM libraries, and Tor only libevent, so this unpacks just
# those .deb files (~3 s). The .deb files are kept in <deb dir> so a workflow
# can cache them and skip `apt-get update` too.
set -euo pipefail
debs="$1"
root=/opt/youtube-egress

curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o "$RUNNER_TEMP/yt-dlp"
sudo install -m 755 "$RUNNER_TEMP/yt-dlp" /usr/local/bin/yt-dlp

if ! compgen -G "$debs/cloudflare-warp_*.deb" > /dev/null; then
  mkdir -p "$debs"
  curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list > /dev/null
  sudo apt-get update -qq
  tss2=$(apt-cache depends cloudflare-warp | sed -n 's/.*Depends: \(libtss2[^ ]*\)/\1/p' | sort -u)
  libevent=$(apt-cache depends tor | sed -n 's/.*Depends: \(libevent-2[^ ]*\)/\1/p' | head -1)
  (cd "$debs" && apt-get download cloudflare-warp $tss2 tor $libevent)
fi

sudo mkdir -p "$root"
for deb in "$debs"/*.deb; do sudo dpkg-deb -x "$deb" "$root"; done
