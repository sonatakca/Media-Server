# Seyirlik processing system: final build plan

## Decision

Build a cross-platform Seyirlik worker inside the existing TypeScript/Node
codebase. FFmpeg remains the media engine; Seyirlik owns discovery, policy,
queueing, progress, validation, promotion, recovery, and the UI. Do not build a
separate Electron application or rewrite the orchestration layer in Rust for
version one.

The delivery format is aligned CMAF/fMP4 HLS with two-second GOPs and segments.
A seek to an exact timestamp does not require one-second files: the player
downloads the two-second range beginning at the preceding independent keyframe,
decodes forward, and presents the requested timestamp. One-second GOPs add
overhead without a meaningful user benefit for normal film playback.

### Production outputs

1. **Universal SDR lane:** H.264 High, 8-bit 4:2:0, AAC LC, 1080p/720p/480p.
2. **HDR lane:** HEVC Main 10 in `hvc1` fMP4, initially 2160p/1080p where the
   source warrants it.
3. **Experimental lane:** AV1 Main 10, generated only when enabled and retained
   only after the target-device matrix passes.
4. **Audio:** video-only quality rungs plus shared audio renditions. Retain the
   source/default language even when it is not English or Turkish, then one best
   English and one best Turkish programme track. Do not retain commentary or a
   second same-language mix by default. Produce universal AAC stereo; add one
   multichannel AAC or E-AC-3 rendition only when the source and target clients
   justify it. The immutable source remains the archival copy of every original
   audio track.
5. **Subtitles:** retain English, Turkish, and forced tracks. Convert text
   subtitles to WebVTT HLS renditions, preserving language, forced, default and
   hearing-impaired flags. Keep original sidecars beside the immutable source.
   Image subtitles are retained but require OCR or opt-in burn-in for browsers.

MPEG-TS is a fallback interoperability option, not a stored primary format.
The lab showed higher overhead, hundreds of small files, and an AAC 7.1 ADTS
failure. Progressive MP4 remains available for downloads, not adaptive playback.

## Processing pipeline

Every job is durable, resumable, cancellable, and idempotent:

1. **Discover:** watch configured Movies and Series roots; ignore artwork,
   trailers, trickplay and generated-output roots.
2. **Identify:** classify movie/episode from its library root and path. Metadata
   and artwork matching occurs after technical processing policy is stable.
3. **Probe:** record container, streams, languages, dispositions, HDR/Dolby
   Vision, frame rate, resolution, bitrate and duration.
4. **Select:** normalize language tags and apply the original/English/Turkish
   audio and English/Turkish/forced subtitle policy.
5. **Detect hardware:** run a real short encode probe, not merely check whether
   an encoder name exists. Prefer VideoToolbox on macOS; NVENC, QSV or AMF on
   Windows; VAAPI, QSV or NVENC on Linux. Fall back to software deliberately.
6. **Plan:** choose only the lanes needed for the source and enabled device
   targets. Never tone-map silently or label HDR output as SDR.
7. **Encode once:** decode the source once where practical, split to aligned
   video rungs, and encode retained audio independently.
8. **Package:** create byte-range, single-file CMAF media assets and HLS masters
   with audio and subtitle groups.
9. **Validate:** verify duration, stream metadata, keyframe/segment alignment,
   random seek decode, cross-quality splice, audio/subtitle selection, HDR
   metadata and exact byte-range delivery.
10. **Promote:** atomically move the validated version into service. Never
    replace or delete the source.
11. **Publish:** update the catalogue and notify the website. Failed versions
    remain diagnostics, never playable output.

## Progress and UI

The worker reports structured events over the existing job system and SSE or a
WebSocket:

- queued, probing, selecting streams, encoding each rung, packaging,
  validating, promoting, completed or failed;
- overall percentage plus stage percentage;
- fps/speed, elapsed time, ETA and output bytes;
- active hardware encoder and fallback reason;
- retained/dropped languages and why;
- estimated versus actual disk impact;
- concise error with expandable FFmpeg diagnostics.

The UI is an integrated admin page with three views: queue, current job and
history. It should have Pause, Resume, Cancel and Retry. Advanced codec controls
remain behind one expandable panel; normal operation should need only a quality
policy and allowed languages.

## Implementation order

### Phase 1 — Policy and contracts

- Add normalized language selection and duplicate/commentary rules.
- Extend adaptive metadata for audio roles and WebVTT subtitle renditions.
- Add unit fixtures for missing, unknown, malformed and conflicting tags.

Exit criterion: the 32-second adversarial MKV deterministically keeps the
correct original/English/Turkish audio and English/Turkish/forced subtitles.

### Phase 2 — Subtitle and audio packaging

- Extract/convert retained text subtitles to WebVTT.
- Add HLS `SUBTITLES` groups and complete audio metadata.
- Validate language switching and forced-subtitle behavior.

Exit criterion: one package switches English/Turkish audio and subtitles
without changing video or reloading the player.

### Phase 3 — Universal SDR and HDR policy

- Install/build FFmpeg with `zscale` or an equivalently audited tone-map path.
- Add BT.2020/PQ to BT.709 SDR conversion and visual reference tests.
- Generate H.264 SDR and HEVC Main 10 HDR lanes from the same HDR source.
- Handle Dolby Vision by explicitly selecting a supported base layer or falling
  back; never claim unsupported Dolby Vision preservation.

Exit criterion: HDR and SDR displays both show correct colour, with no clipping,
washed blacks or accidental HDR tags.

### Phase 4 — Durable worker and live progress

- Move the offline CLI behind database jobs with leases, resume and cancellation.
- Persist stage checkpoints and versioned output manifests.
- Stream progress to the integrated minimal admin UI.

Exit criterion: killing the worker mid-encode and restarting it never exposes a
partial package and produces a clear resume or retry outcome.

### Phase 5 — Device certification

- Safari on macOS/iPhone/iPad/Apple TV.
- Chromium on macOS/Windows/Android/Google TV.
- Firefox desktop.
- One low-power or older H.264-only client.
- Local, Wi-Fi-constrained and remote/Cloudflare paths.

Exit criterion: the checklist below passes for universal H.264, HDR HEVC on
supported devices, language selection, exact seeking and automatic quality
switches. AV1 remains experimental until its entire intended device subset
passes.

The current Safari lab result reinforces that boundary: AV1 HDR in WebM is not
a universal delivery asset. The successful fallback is a prebuilt aligned HEVC
Main 10 HDR package, selected when Safari reports no AV1 support. The production
worker must generate compatible lanes before publication; live conversion is
an emergency fallback, not the normal delivery path.

### Phase 6 — FileFlows removal

- Run Seyirlik in shadow mode on new files while FileFlows remains disabled for
  those paths.
- Canary five titles, then one complete series, then all new arrivals.
- Keep source files and the previous validated rendition version for rollback.
- Remove FileFlows containers, mounts, credentials and execution hooks only
  after two weeks of clean automated processing.

Exit criterion: no FileFlows process, volume, environment variable or execution
path is required for scan, processing or playback.

## How to test now

### Automated checks

From the project directory:

```sh
npm run media:lab:build-matrix
npm run media:lab:verify-matrix
```

Start the isolated server in a separate terminal if it is not already running:

```sh
npm run build
npm run media:lab:server
```

To rescan the lab and test authenticated HLS, direct-play decisions, an exact
middle byte range, and a real MKV-to-fMP4 remux session, run:

```sh
SEYIRLIK_LAB_SCAN=true \
npm run media:lab:verify-http
```

The verifier refuses any database whose name does not end in `_lab`, creates a
temporary account, and removes that account afterward. The AV1 compatibility
fixture must deliver its prebuilt HEVC HDR package to a non-AV1 Safari profile;
the verifier treats any fallback error as a failure.

### Manual website checks

Open `http://127.0.0.1:43111`, sign in, open Movies and test these eight items:

| Item                                  | What must happen                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Dune HDR Lab                          | HLS direct play; Auto/1080p/720p/480p; exact seeks; two audio choices               |
| Dune Language Fixture                 | Detect three audio and three subtitle tracks; exposes the policy gap before Phase 1 |
| Compatibility - H264 Progressive      | Instant direct play; English/Turkish audio and subtitles                            |
| Compatibility - H264 Fragmented       | Same behavior as progressive; quick non-zero seek                                   |
| Compatibility - H264 Multilingual MKV | Fast remux; video and AAC copied; English/Turkish/forced subtitle choices           |
| Compatibility - HEVC HDR              | Direct on HEVC/HDR clients; correct colour and black level                          |
| Compatibility - AV1 HDR               | Direct only on declared AV1/HDR clients; otherwise fallback                         |
| Compatibility - VP9 Opus WebM         | Direct on compatible Chromium/Firefox clients                                       |

For each item:

1. Start at 0:00, seek to the middle, then one second before the end.
2. Repeat ten seeks to arbitrary exact seconds; record the longest visible wait.
3. Switch every audio and subtitle option while playing.
4. For Dune, force 480p, 720p and 1080p, then return to Auto.
5. Throttle the connection or use a constrained Wi-Fi link; confirm Auto drops
   quality without stopping audio and recovers upward afterward.
6. Confirm the diagnostics panel reports Direct Play, Remux or Transcode as
   expected, with the selected codec and no repeated live FFmpeg start.
7. On HDR displays, compare HEVC/AV1 with the source. A washed-out, too-dark or
   clipped image is a failure even if playback technically starts.

Record per device: OS/browser version, hardware model, item, startup time,
seek latency, quality switches, dropped frames, selected audio/subtitle, HDR
appearance, CPU use and pass/fail.
