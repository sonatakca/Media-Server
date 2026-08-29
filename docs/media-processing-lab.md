# Media processing lab

This lab replaces assumptions about delivery formats with measurements from a
demanding five-minute 4K HDR source. It is isolated from the real library:
everything below lives under `/Volumes/Expansion/seyirlik-lab`, and the source
under `/Volumes/Expansion/media` is never modified.

## Current decision

Use aligned CMAF/fMP4 HLS as the primary delivery format:

- one video-only asset per quality;
- shared audio renditions, stored once rather than duplicated into each video;
- aligned two-second keyframes and segments for accurate seeking and seamless
  automatic quality switching;
- byte-range media playlists, avoiding hundreds of tiny segment files;
- HEVC Main 10 for the first HDR lane;
- H.264 SDR as the universal fallback after the FFmpeg build has a trustworthy
  HDR-to-SDR filter such as `zscale`;
- AV1 as an experimental storage-efficient lane until target-device hardware
  decode coverage and encoding throughput are measured.

Do not use MPEG-TS as the main format. In this test it consumed about 111 MiB
versus 83 MiB for equivalent fragmented MP4, produced 151 small files, and
could not stream-copy the source AAC 7.1 track into ADTS. It only succeeded
after that track was downmixed and re-encoded to stereo.

## Fixture

The source is `Dune (2021) - 5m HDR source.mp4`: 300.58 seconds, 3840x1604,
23.976 fps, H.264 High 10, HDR10 BT.2020/PQ, English AAC 7.1 and English E-AC-3
5.1. A Turkish SRT sidecar is present. A separate 32-second adversarial MKV
adds English, Turkish, and French-labelled audio plus default, forced, English,
and Turkish subtitles for language-policy testing.

## Results

The full five-minute native package completed in about 95 seconds on the test
Mac with Apple VideoToolbox, or roughly 3.16 times real-time overall. It is
about 142 MiB and contains:

| Video rung | Approximate size | Average bitrate | Observed peak |
| ---------- | ---------------: | --------------: | ------------: |
| 1080p      |         72.9 MiB |       2.03 Mbps |     6.89 Mbps |
| 720p       |         32.6 MiB |       0.91 Mbps |     3.37 Mbps |
| 480p       |         13.0 MiB |       0.36 Mbps |     1.78 Mbps |

Two shared English AAC audio renditions are about 9.72 MiB each. All three
video playlists contain 151 aligned segments with a maximum observed duration
of 2.002 seconds. Package validation passed seek-decode and cross-quality splice
checks.

A 30-second 1080p HDR comparison produced these directional results. Default
VMAF is only a proxy for HDR perception, so these numbers are useful for
relative screening, not final visual approval.

| Codec                      | Approximate size | Average bitrate |  VMAF | Practical conclusion                             |
| -------------------------- | ---------------: | --------------: | ----: | ------------------------------------------------ |
| HEVC Main 10, VideoToolbox |           13 MiB |       3.64 Mbps | 90.12 | Fast, practical Apple HDR baseline               |
| AV1 SVT, CRF 30            |          2.9 MiB |       0.73 Mbps | 88.91 | Excellent size, experimental delivery lane       |
| AV1 SVT, CRF 26            |          3.9 MiB |       0.98 Mbps | 89.76 | Better AV1 candidate, still needs device testing |

## Real HTTP verification

The repeatable verifier logs into the isolated lab with a temporary account,
creates a real playback session, fetches the authenticated adaptive master and
media playlist, requests a middle byte range, then removes the temporary
account. It refuses to run unless the database name ends in `_lab`.

Run it only while the lab server is listening on port 43111:

```sh
SEYIRLIK_LAB_DATABASE_URL='postgresql://.../seyirlik_lab' \
  npm run media:lab:verify-http
```

The verified result is direct HLS playback with no live transcode, three video
variants, two shared audio renditions, 151 intervals, and an exact HTTP 206
response for a segment near the middle of the film.

The browser matrix on Safari produced these additional results:

- H.264 progressive and fragmented MP4, HEVC HDR MP4, VP9/Opus WebM, the Dune
  adaptive package, and the language fixture play successfully.
- H.264/AAC multilingual MKV requires a live remux. Its initial failure exposed
  an absolute-path bug in the fMP4 initialization filename; the fixed real
  session now returns HLS successfully without re-encoding video or audio.
- AV1 HDR WebM direct-plays only when the client actually reports AV1 support.
  A non-AV1 Safari client now receives a prebuilt HEVC Main 10 HDR CMAF package
  with aligned 1080p, 720p, and 480p rungs. The package was produced with Apple
  VideoToolbox in about nine seconds and avoids unsafe live tone mapping.
- Pointer seeking was incorrectly snapped to three-second multiples in the UI.
  That snap has been removed. The two-second CMAF boundary remains correct:
  playback seeks to an arbitrary timestamp by decoding forward from the prior
  keyframe.

## Playback compatibility audit

Every fixture was driven through startup, seeking, audio, subtitles and quality
in both engines: Chrome via the installed Google Chrome, and Safari via WebKit
on the native-HLS code path, with spot confirmation in Chrome 148 and Safari
itself. What that surfaced:

- **Multichannel audio does not survive the shared adaptive ladder.** ffmpeg's
  7.1 layout is AAC `channelConfiguration` 12, which Chromium's MSE parser
  rejects outright (`CHUNK_DEMUXER_ERROR_APPEND_FAILED`), so both multichannel
  titles failed to start in Chrome while playing normally in Safari. 5.1 is not
  a safe compromise either: Chrome 148 fails a 5.1 rendition with
  `PIPELINE_ERROR_DECODE` on the first append after a seek where the identical
  stereo package plays. One shared ladder can only carry stereo. Surround stays
  on the original file, which is offered alongside whenever it direct-plays.
- **Safari has no JavaScript control surface for an adaptive package.** It
  exposes no level API, and an HLS rendition group never appears in
  `video.audioTracks`. Quality and audio selections are therefore applied to the
  master playlist on the way out — filtered to one rung, or re-stamped so the
  chosen audio rendition is the default one — and the player re-plans against
  that manifest, preserving position and play state.
- **`loadLevel` alone is not a manual quality control.** It changes only what is
  fetched next, so on a title whose timeline is already buffered a manual rung
  did nothing visible for minutes. `nextLevel` replaces the buffer ahead of the
  play head instead, and the rung lands within a second or two without the black
  frame a full flush would cause.
- **A remux has to declare itself VOD.** Without `EXT-X-PLAYLIST-TYPE:VOD`,
  Safari reads a playlist that has not yet reached `EXT-X-ENDLIST` as live and
  clamps every seek to the live edge, so scrubbing a remuxed title jumped to the
  end. VOD also keeps the whole segment list, where ffmpeg's default window of
  five drops the start of anything longer than twenty seconds.
- **Reaching the end of a title must not end the session.** The element stays
  attached and seekable, so a viewer scrubbing back needs the same session;
  ending it made the next range request 404 and killed playback with
  `PIPELINE_ERROR_READ: FFmpegDemuxer: data source error`.
- **Adaptive asset URLs are served `immutable`, so they have to be keyed to the
  package build**, not to the source file. Keyed on the source alone, a
  regenerated package reused the same URLs and clients that had cached the
  previous build read its playlists and byte ranges against the new media —
  silent, unrecoverable failure with no error to explain it.
- **A browser with no `audioTracks` cannot select a track inside a directly
  played file.** No Chromium implements it, so an explicit non-default audio
  choice now forces a remux mapping only that stream; served directly, choosing
  Turkish changed nothing audible and the player retried forever.

Remaining browser-specific limitation: the adaptive lane delivers stereo to
every client. Restoring surround for the clients that can decode it would need a
second audio ladder chosen per client, which is a larger change than the
compatibility floor this audit established.

## Work still required before production policy is frozen

1. Add the audio policy: keep the original/default track plus at most one best
   English and one best Turkish track. Do not retain unrelated languages unless
   explicitly requested. Commentary tracks should be opt-in.
2. Convert retained text subtitles to WebVTT and add them as HLS subtitle
   renditions. Keep English, Turkish, and forced tracks. Preserve an original
   subtitle sidecar for download; image subtitles require OCR or burn-in.
3. Install or build FFmpeg with `zscale` or an equivalent audited HDR-to-SDR
   path, then generate and visually approve the H.264 SDR fallback.
4. Test Safari/iPhone/iPad/Apple TV, Chromium/Android/Google TV, and a low-power
   client before promoting AV1 from experimental.
5. Add frontend playback telemetry for current quality, selected language,
   buffer health, dropped frames, seek latency, and quality-switch failures.

The processing application should be cross-platform at the orchestration layer
but use OS-specific hardware adapters: VideoToolbox on macOS, NVENC/QSV/AMF on
Windows, and VAAPI/QSV/NVENC on Linux. The UI should remain a small local web UI
showing queue, current stage, percentage, speed/ETA, selected hardware path,
language decisions, validation result, and disk impact. FFmpeg command details
belong behind an expandable diagnostics panel.
