#!/usr/bin/env bash
# Builds the progressive-vs-fragmented MP4 benchmark pair used by
# src/components/player/containerBenchmark.browser.test.tsx.
#
# One encode, remuxed three ways with `-c copy`, so codec, bitrate, resolution,
# duration, frame rate and GOP are identical across arms and the only variable
# is the container layout. Duration and frame rate are matched to a real feature
# rendition because the progressive `moov` scales with sample count.
set -euo pipefail

FIXTURES="${TMPDIR:-/tmp}/seyirlik-rendition-fixtures"
DURATION=9326
mkdir -p "$FIXTURES"
cd "$FIXTURES"

if [ ! -f bench-progressive.mp4 ]; then
  echo "Encoding source (~${DURATION}s)…"
  ffmpeg -hide_banner -loglevel error \
    -f lavfi -i "testsrc=size=640x268:rate=24:duration=${DURATION}" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${DURATION}" \
    -c:v libx264 -preset ultrafast -b:v 900k -g 48 -keyint_min 48 -sc_threshold 0 \
    -bf 3 -pix_fmt yuv420p -c:a aac -b:a 128k \
    -movflags +faststart -y bench-progressive.mp4
fi

echo "Remuxing fragmented (no index)…"
ffmpeg -hide_banner -loglevel error -i bench-progressive.mp4 -c copy \
  -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 \
  -y bench-fragmented.mp4

echo "Remuxing fragmented (global sidx)…"
ffmpeg -hide_banner -loglevel error -i bench-progressive.mp4 -c copy \
  -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx -frag_duration 2000000 \
  -y bench-fragmented-sidx.mp4

ls -la "$FIXTURES"/bench-*.mp4
