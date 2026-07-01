# Native playback architecture

## Decision

Seyirlik should use two playback engines:

1. The existing HTML video/HLS engine remains the web and PWA fallback.
2. Windows, Linux, and macOS desktop builds should use a native `libmpv`
   renderer backed by FFmpeg and the operating system's hardware decoders.

The playback backend now accepts a native capability profile through
`createNativeClientCapabilities()`. A native client can therefore direct-play
MKV, HEVC, AV1, VP9, DTS, TrueHD, FLAC, ASS, PGS, and other formats when its
local engine reports support. Browser clients remain limited to formats their
actual browser probes support.

`libmpv` is the preferred engine because it provides one cross-platform API,
hardware decoding, HDR handling, embedded text/image subtitles, audio track
selection, and mature FFmpeg codec support. The desktop shell still needs to
be implemented and packaged with signed platform-specific `libmpv` binaries.

## Transcode policy

For interactive playback, one transcode job is assigned to one machine:

- Direct play and local hardware decode are always preferred.
- If the native client can decode the source, the server only serves byte
  ranges and performs no transcode.
- If conversion is required, use a healthy hardware encoder on the selected
  node.
- The server falls back to bounded `libx264` threads if a detected hardware
  encoder cannot start.
- Video transcode concurrency is capped so playback cannot consume the entire
  server.

Splitting a live transcode between client and server is intentionally not the
default. It requires downloading source chunks to the client, uploading
encoded chunks, deterministic keyframes, timestamp reconciliation, ordered
assembly, retries, authentication, and thermal/load monitoring. On a LAN this
can help offline pre-generation, but for live playback it commonly increases
startup time and total power use.

A future cooperative worker protocol should therefore be used for:

- offline optimized-version generation;
- ahead-of-playback cache warming;
- background subtitle OCR or media analysis;
- segment jobs only when both nodes are wired/fast, cool, and idle.

It should not be used for ordinary direct playback.

## Native desktop milestones

1. Build a thin Tauri or native shell hosting the existing React UI.
2. Add a `libmpv` rendering surface and a typed command/event bridge.
3. Generate the request payload with `createNativeClientCapabilities()`.
4. Map the existing player controls to mpv properties and events.
5. Package `libmpv`/FFmpeg per platform and add codec/HDR/audio test fixtures.
6. Add signed installers, auto-update, crash recovery, and sandboxed URL/token
   handling.
7. Add optional client-worker registration only after thermal, battery, load,
   and network eligibility checks exist.

## Server controls

The playback backend supports these environment variables:

```text
SEYIRLIK_FFMPEG_PATH=ffmpeg
SEYIRLIK_FFMPEG_VIDEO_ENCODER=auto
SEYIRLIK_MAX_VIDEO_TRANSCODES=1
SEYIRLIK_SOFTWARE_TRANSCODE_THREADS=4
```

`SEYIRLIK_FFMPEG_VIDEO_ENCODER` accepts `auto`, `hardware`, `software`,
`h264_videotoolbox`, `h264_nvenc`, `h264_qsv`, or `h264_amf`.

Automatic preference:

- macOS: VideoToolbox, then NVENC, then bounded `libx264`
- Windows: NVENC, Quick Sync, AMF, then bounded `libx264`
- Linux: NVENC, Quick Sync, then bounded `libx264`

VAAPI is not selected automatically yet because reliable VAAPI use also
requires device discovery and filter/upload graph handling.

Runtime state is available from:

```text
GET /api/playback/runtime
```

HDR/Dolby Vision sources that require video conversion receive an SDR tone-map
filter before H.264 output when FFmpeg provides both `zscale` and `tonemap`.
When that safe filter chain is unavailable, startup fails clearly so the client
can fall back to Jellyfin instead of receiving incorrectly colored video.
