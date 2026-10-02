#!/usr/bin/env bash
# Re-encodes YouTube's Opus audio to the speech-quality Opus the object store
# keeps: 16 kHz mono at 24 kbps in WebM, ~11 MB per hour against ~50 MB for
# YouTube's ~110 kbps stereo. The pipeline's models take 16 kHz mono, so
# nothing they can use is lost.
# Usage: encode-speech-audio.sh <input> <output .webm>
#
# On speech, decoding this with webmOpusToWav gives the same length as the
# original, at zero lag, with correlation ~0.997.
set -euo pipefail
in="$1"
out="$2"

# ffmpeg's own stereo-to-mono downmix adds the channels at -3 dB each, which
# makes dual-mono audio (most meetings) 3 dB louder and can clip it. Averaging
# them is what libopus does when asked to decode stereo as mono.
channels=$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$in")
case "$channels" in
  1) mix=(-ac 1) ;;
  2) mix=(-af "pan=mono|c0=0.5*c0+0.5*c1") ;;
  *) echo "unexpected channel count: $channels" >&2; exit 1 ;;
esac

# -map_metadata -1 and bitexact keep encoder versions and tags out of the file.
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$in" -map 0:a:0 "${mix[@]}" \
  -ar 16000 -c:a libopus -b:a 24k -map_metadata -1 -fflags +bitexact "$out"
