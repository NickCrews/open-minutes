#!/usr/bin/env bash
# Unpacks Cloudflare WARP and Tor into <root> (default /opt/youtube-egress, or
# $YOUTUBE_EGRESS_ROOT) for up.sh, rather than installing them. Linux with apt
# only; elsewhere install Tor yourself (up.sh finds it on PATH).
# Usage: install.sh <deb dir> [<root>]
#
# Installing the cloudflare-warp package with apt pulls in its desktop app's
# dependencies (GTK, WebKit, GStreamer) and takes ~30 s. The daemon and CLI
# need only two TPM libraries, and Tor only libevent, so this unpacks just
# those .deb files (~3 s). The .deb files are kept in <deb dir> so a workflow
# can cache them and skip `apt-get update` too.
set -euo pipefail
if [ $# -lt 1 ]; then
  echo "Usage: install.sh <deb dir> [<root>]" >&2
  exit 2
fi
debs="$1"
root="${2:-${YOUTUBE_EGRESS_ROOT:-/opt/youtube-egress}}"

if [ "$(uname -s)" != Linux ] || ! command -v apt-get > /dev/null; then
  echo "install.sh needs Linux with apt. Install Tor yourself (brew install tor) and run up.sh tor." >&2
  exit 1
fi

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

if ! compgen -G "$debs/cloudflare-warp_*.deb" > /dev/null; then
  mkdir -p "$debs"
  codename=$(lsb_release -cs 2> /dev/null || (. /etc/os-release && echo "$VERSION_CODENAME"))
  curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | as_root gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $codename main" | as_root tee /etc/apt/sources.list.d/cloudflare-client.list > /dev/null
  as_root apt-get update -qq
  tss2=$(apt-cache depends cloudflare-warp | sed -n 's/.*Depends: \(libtss2[^ ]*\)/\1/p' | sort -u)
  libevent=$(apt-cache depends tor | sed -n 's/.*Depends: \(libevent-2[^ ]*\)/\1/p' | head -1)
  # shellcheck disable=SC2086 # word-split into package names
  (cd "$debs" && apt-get download cloudflare-warp $tss2 tor $libevent)
fi

as_root mkdir -p "$root"
for deb in "$debs"/*.deb; do as_root dpkg-deb -x "$deb" "$root"; done
