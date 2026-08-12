# Pre-generated rendition roadmap

Follow-up work for the offline rendition system (`src/renditions`, `scripts/media-renditions.ts`,
`src/server/renditionService.ts`). Everything here is deferred, not broken — the
system works as designed. Numbers are measured on the live library
(`D:\media`, 284 eligible videos) and on the Windows box's Intel UHD 630, not estimated.

---

## 1. Native-resolution top rung (the "no 4K option" gap)

**Problem.** The ladder stops at 1080p because the original was assumed to serve as
the top rung. That holds only while the original can direct-play. When it cannot,
the title has no 4K option at all — the picker shows 1080p/720p/480p and nothing above.

Originals fail to direct-play for two reasons in this library:

| Cause                            | Chrome | Safari (macOS) |
| -------------------------------- | ------ | -------------- |
| H.264 **High 10** video (10-bit) | no     | yes            |
| **E-AC-3 / AC-3** audio          | no     | yes            |

Measured audio codecs of the default track:

| Library                       | AAC    | E-AC-3 | AC-3  |
| ----------------------------- | ------ | ------ | ----- |
| Movies                        | 27     | 8      | 1     |
| Series                        | 171    | 72     | 3     |
| **4K sources (width ≥ 3000)** | **36** | **70** | **4** |

So **74 of 111 4K titles** carry audio Chrome cannot decode. The manifest correctly
withholds those originals per-client — offering them would mean silent playback or a
live transcode, which the quality system exists to avoid.

**Fix.** Generate a rung at the source's own quality class (e.g. 3840x1600 for
Fight Club) as HEVC Main 10 with AAC audio, so it plays in every browser. This is a
straight re-encode at native resolution, never an upscale.

**Cost.** 29 of 36 Movies are 4K, roughly 6 GiB each ≈ **~175 GiB**, plus comparable
encode time. Movies output alone is ~130 GiB against ~874 GiB free, so it fits, but
it is not free.

**Scope options**, cheapest first:

1. `--top-rung` flag for named titles only — best if Safari is the primary client.
2. Only where the original cannot direct-play _anywhere_ (High 10 video or non-AAC
   audio). Determinable offline from the probe, so it fills exactly the gaps.
3. All 4K titles, uniform behaviour everywhere.

Option 2 is the most principled; option 1 is the cheapest.

---

## 2. Self-calibrating storage estimates

`expectedVideoBitrate` in `src/renditions/encoding.ts` is a reasoned default.
Measured against the real Dune encode it **overestimates by ~2.5x**: the projection
said 1067 GiB for the whole library, the measured rate implies **~422 GiB** against
688 GiB usable. The planner therefore defers ~163 titles that would comfortably fit.

**Fix.** Have `analyse` measure actual bytes-per-second from completed renditions,
per codec family and quality class, and use that for remaining projections, falling
back to the constants where there is no data yet. Accuracy improves with every title.

---

## 3. Gapless quality switching — done

**Was.** Switching preloaded the target file in a hidden element while the current
quality kept playing, then swapped. That removed the _download_ wait but not the
swap itself: there was one video element, so assigning the new `src` discarded the
decode pipeline, the buffer and the position in one statement. The viewer saw
playback pause, a black frame, `00:00 / 00:00` on the controls, and a second
buffering wait after the seek back.

**Now.** Two full-size video elements share the viewport — one active, one standby —
and roles swap on a successful handoff. The standby loads the target, seeks about a
second _ahead_ of the playhead, buffers, primes its decoder and waits there with a
real frame painted until the active deck's clock arrives. Promotion is then an
opacity and audio change, not a load. The element that prepared the bytes is the
element that goes on to play them.

- `deckModel.ts` — thresholds, the switch state machine, the promotion gate, the
  eligibility rules and the diagnostics shape. No DOM, no timers.
- `prepareStandbyDeck.ts` — the preparation sequence against a structural media
  interface, so the ordering is testable without a decoder.
- `useSeamlessQualitySwitch.ts` — deck identities, the switch token, the
  authoritative active-element ref, the deck epoch that rebinds listeners after a
  promotion, promotion, rollback and cleanup.

Measured in Chromium against two FFmpeg-generated 10 s renditions (`npm run
test:browser`): preparation ~16 ms on a local file, ~7 s buffered past the handoff
point, drift at handoff **0.047 s**, handoff **17 ms**, and a maximum timeline
discontinuity of **0 s** — the displayed clock never stepped backwards at all.

**Scope.** The dual-deck path is for validated complete files on one timeline. Audio
changes needing a different encode, HLS sessions, non-seekable sources, codec
changes and title changes still use controlled source replacement, and
`evaluateSeamlessEligibility` is what keeps them out of it.

**Still open.** The handoff cuts on a decoded frame, not on a segment boundary, so
its accuracy depends on both files being seekable to the same instant. That holds
for this ladder because the encoder writes a fixed GOP with scene detection off, and
validation already rejects a rendition whose duration drifts from the source. If a
future rung breaks that assumption, segment-aligned CMAF/HLS with a shared
presentation timeline is the principled answer — see item 7.

---

## 4. Concurrent workers

`--workers 2`/`3` would overlap the CPU-bound 10-bit decode with the GPU encode and
should cut wall time materially — HDR titles run at ~1.3x versus ~2x for SDR because
software 10-bit H.264 decode is the bottleneck, not the encoder.

**Blocker.** The progress renderer in `scripts/media-renditions.ts` assumes a single
worker; two workers interleave and fight over the same in-place status line. Fix the
renderer (per-title lines, or a summary line plus scrolling events) before advising
concurrency.

---

## 5. Known data problems in the library

- **`Movies/The Silence of the Lambs (1991)/…[274].mp4` is corrupt.** ffprobe fails
  with `Invalid data found when processing input`. Reports as `failed` in every
  analysis. Needs replacing at source.
- **`Movies/Kolpachino 4 4's (2024)/…[1221291].mp4` fails validation.** Both the
  first attempt and the retry ended with _"Validated rendition duration differs from
  the source beyond tolerance"_ after ~10 minutes. Source is 1:37:51, 1920x800, SDR.
  Likely a variable-frame-rate source or wrong duration metadata in the container.
  Worth probing `nb_frames` vs `duration` and comparing against a decoded frame
  count before deciding whether to widen the tolerance or fix the source.
- **46 sources are 8-bit but tagged `smpte2084`/`bt2020`.** HDR10 requires 10 bits;
  8-bit PQ bands visibly. These are mis-tagged transcodes. The pipeline preserves the
  tags faithfully, so the output is only as good as the source. Re-tagging them as
  BT.709 at source would be more honest.

---

## 6. Smaller items

- **Mastering-display metadata (MaxCLL / MaxFALL) is not written.** `hevc_qsv` does
  not emit it and the parsing/conversion for `libx265`'s `master-display` string is
  fiddly. HDR10 still works — displays fall back to defaults — but tone mapping on
  the client is less precise.
- **Vulkan/libplacebo tone mapping.** Only relevant under
  `SEYIRLIK_RENDITION_HDR=tonemap`. Benchmarked at ~4.4x versus ~0.8x for the
  software zscale chain, but failed with `VK_ERROR_DEVICE_LOST` over SSH. May work
  from an interactive desktop session; worth retesting there.
- **Rendition root inside the media root.** Currently warned about at CLI start.
  Library automation (FileFlows, Tdarr) that scans the media root will re-encode or
  delete generated output in place — this already destroyed one Dune run. Resolved
  here by excluding `.seyirlik` in FileFlows; the warning has no way to detect that,
  so an env opt-out (`SEYIRLIK_RENDITION_ALLOW_INSIDE_MEDIA_ROOT`) would silence it.
- **Auto's opening bid.** With no `navigator.connection` (Safari, Firefox) Auto opens
  at 1080p and climbs on measured buffer health. If cold starts feel too conservative
  on fast links, seed the first pick from a short throughput probe instead.

---

## 7. Segment-aligned CMAF/HLS (a later improvement, not a blocker)

The dual-deck handoff meets its target on this ladder, so this is an improvement
rather than a fix. It would be worth doing if any of the following start to bite:

- **A rung whose keyframes do not line up.** The rendezvous seek lands on the
  nearest keyframe, so a rung encoded with scene-detected GOPs would meet the
  playhead less precisely than the measured 0.047 s.
- **Two decoders at once.** Preparation briefly decodes on both elements. On a
  weak client that is real CPU and memory that a single MSE pipeline with a
  segment append would not spend.
- **Bandwidth spent twice at the switch point.** The overlapping second is
  fetched from both renditions.

`MediaQualityManifest.limitations.switching` still reads
`"complete-file-rebuffer"`. That string is now wrong for the seamless path, but
it is a server-emitted contract field with a validator behind it and nothing in
the UI reads it, so it was left alone rather than changed as a side effect of a
player refactor.

---

## Reference: measured performance (Intel UHD 630, QuickSync)

| Case                                         | Speed | Notes                                                |
| -------------------------------------------- | ----- | ---------------------------------------------------- |
| SDR → 480p+720p(+1080p), `h264_qsv`          | ~2.0x | hardware decode                                      |
| HDR → full ladder, `hevc_qsv`, HDR preserved | ~1.3x | software 10-bit H.264 decode is the bottleneck       |
| HDR → SDR tone mapped (`tonemap` policy)     | ~0.6x | zscale tone map is CPU-bound and cannot be offloaded |
| QSV scale only, no tone map                  | ~6.3x | shows the encoder is never the limit                 |

Whole library: 341.3 hours of content (85.4 h of it HDR), ~192 hours single-worker.
Movies alone: 36 titles, 77.0 hours, ~130 GiB, ~50 hours single-worker.
