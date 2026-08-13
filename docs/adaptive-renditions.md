# Aligned adaptive renditions

Seyirlik's `cmaf-hls-aligned-v1` profile provides seamless quality changes with
one persistent player pipeline. It is a second generation alongside the existing
complete MP4 ladder, not an in-place conversion.

## What is generated

For each eligible title, one ffmpeg invocation decodes the source once and writes:

- video-only H.264 SDR or HEVC Main 10 HDR renditions;
- a closed, forced two-second GOP shared by every video rendition;
- one AAC rendition per selected source audio track (the default track unless
  `--all-audio-tracks` is requested);
- fMP4/CMAF HLS with one `media.m4s` file per rendition and byte ranges in the
  media playlist;
- a measured multivariant master with bandwidth, resolution, frame rate, RFC
  6381 codec strings, audio groups and HDR range signalling.

The single-file byte-range layout avoids creating hundreds of thousands of tiny
segment files. Every package is built under the work root, validated deeply, then
promoted as an immutable version. `current-adaptive.json` is swapped only after
validation passes. The legacy `current.json` pointer is never changed by adaptive
processing.

## Safe rollout

1. Analyse only. This probes the library and writes no media:

   ```text
   npm run media:renditions:analyse
   ```

   Review the adaptive coverage, shared-audio estimate, migration overhead and
   storage deferrals in the console and `rendition-analysis.json`.

2. Generate and validate one representative SDR title:

   ```text
   # Replace this sample with the exact path below SEYIRLIK_MEDIA_ROOT,
   # including the real filename and extension.
   npm run media:renditions:process -- --profile adaptive --source "Movies/Title (2026)/Title (2026).mkv" --dry-run
   npm run media:renditions:process -- --profile adaptive --source "Movies/Title (2026)/Title (2026).mkv"
   npm run media:renditions:validate -- --profile adaptive --source "Movies/Title (2026)/Title (2026).mkv"
   ```

3. Repeat for an HDR title, a 23.976 fps title, a variable-frame-rate title and a
   title whose default audio is AC-3/E-AC-3. Confirm colour, seeking, audio and
   quality changes in Chromium and WebKit/Safari.

4. Expand by library or stable media id. Resume is idempotent and reuses an
   already-valid version:

   ```text
   npm run media:renditions:resume -- --profile adaptive --library Movies --workers 1
   npm run media:renditions:status
   ```

5. Keep the old MP4 generation through the observation period. Seyirlik will use
   a valid adaptive package first, retain Original as a separate option, and fall
   back to complete files or the existing live planner when adaptive media is
   missing, stale, invalid or unsupported by the client.

`--profile all` runs legacy then adaptive processing deliberately. The default is
still `legacy`, so an existing automation cannot unexpectedly begin re-encoding
the whole library after deployment.

## Why existing renditions need a new video encode

The inspected library's completed MP4 renditions are H.264/AAC or HEVC/AAC and
their sampled keyframe timestamps align across qualities. Their GOP intervals are
about 10.24–10.72 seconds, however. They can be remuxed without quality loss only
into similarly coarse HLS segments. They cannot become independently decodable
two-second switching segments without inserting new video keyframes, and inserting
those keyframes requires video re-encoding.

Sources do not need to be replaced. MP4 + H.264/HEVC + AAC/AC-3/E-AC-3 inputs are
accepted: compatible AAC is stream-copied into shared audio; other audio is
transcoded to AAC. The required work is regeneration of the adaptive video ladder,
not reprocessing or deleting the source library.

## Playback and limitations

- hls.js ABR owns Auto mode. Manual selection sets `loadLevel`, so the change is
  applied at a future aligned fragment without clearing buffered media.
- Low Data caps ABR at the lowest rung; Higher Resolution permits the highest
  compatible rung; Advanced locks an exact rung.
- Original is not part of the switching set. Entering or leaving Original is a
  source transition and may briefly rebuffer.
- Safari's native HLS engine provides seamless ABR but does not expose its level
  selection API to JavaScript. Exact application-controlled locks are available
  where hls.js/MediaSource is used; native Safari may manage the level itself.
- HDR packages are offered only to clients that report HEVC/HDR capability.
- A requested audio track must exist in the adaptive package. Otherwise the
  normal playback planner falls back to complete-file or live processing.
- Embedded subtitles are not muxed into the adaptive video set. Text subtitles
  continue through the existing external subtitle path; image subtitles that
  require burn-in use live transcoding.

## Storage and cleanup

Adaptive estimates count video once per rung and audio once per selected track.
The migration estimate assumes legacy and adaptive generations coexist. Packaging
also preserves the prior adaptive version until the new one validates, so the
per-title free-space preflight includes temporary overlap and the configured
reserve.

`cleanup` removes abandoned work directories only, skips both legacy and adaptive
active locks, and never deletes completed versions. Remove a specific obsolete
version only after an observation period and an explicit operator review; source,
legacy output and the active adaptive pointer are never cleanup targets.
